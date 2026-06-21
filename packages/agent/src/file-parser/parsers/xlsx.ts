/**
 * xlsx parser - Office Open XML spreadsheets.
 *
 * The output intentionally keeps cell references so renderer and Agent
 * consumers can point back to a stable workbook location.
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { RawParse } from '../types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function collectText(node: unknown): string {
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  if (typeof obj['#text'] === 'string') return obj['#text'];
  let text = '';
  for (const [key, value] of Object.entries(obj)) {
    if (key === 't' || key.endsWith(':t')) text += collectText(value);
    else if (key === 'r' || key.endsWith(':r')) text += collectText(value);
  }
  return text;
}

function resolveTarget(target: string): string {
  const clean = target.replace(/^\//, '');
  if (clean.startsWith('xl/')) return clean;
  return `xl/${clean.replace(/^\.\.\//, '')}`;
}

export class XlsxParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);
    const workbookEntry = zip.file('xl/workbook.xml');
    if (!workbookEntry) {
      throw new Error('Invalid .xlsx: missing xl/workbook.xml');
    }

    const sharedStrings: string[] = [];
    const sharedEntry = zip.file('xl/sharedStrings.xml');
    if (sharedEntry) {
      const shared = xmlParser.parse(await sharedEntry.async('string')) as {
        sst?: { si?: unknown | unknown[] };
      };
      for (const item of asArray(shared.sst?.si)) sharedStrings.push(collectText(item));
    }

    const relationships = new Map<string, string>();
    const relsEntry = zip.file('xl/_rels/workbook.xml.rels');
    if (relsEntry) {
      const rels = xmlParser.parse(await relsEntry.async('string')) as {
        Relationships?: { Relationship?: Record<string, string> | Array<Record<string, string>> };
      };
      for (const rel of asArray(rels.Relationships?.Relationship)) {
        const id = rel['@_Id'];
        const target = rel['@_Target'];
        if (id && target) relationships.set(id, resolveTarget(target));
      }
    }

    const workbook = xmlParser.parse(await workbookEntry.async('string')) as {
      workbook?: { sheets?: { sheet?: Record<string, string> | Array<Record<string, string>> } };
    };
    const output: string[] = [];

    for (const [sheetIndex, sheet] of asArray(workbook.workbook?.sheets?.sheet).entries()) {
      const name = sheet['@_name'] || `Sheet${sheetIndex + 1}`;
      const relationshipId = sheet['@_r:id'];
      const worksheetPath = relationships.get(relationshipId) || `xl/worksheets/sheet${sheetIndex + 1}.xml`;
      const worksheetEntry = zip.file(worksheetPath);
      if (!worksheetEntry) continue;

      output.push(`--- Sheet: ${name} ---`);
      const worksheet = xmlParser.parse(await worksheetEntry.async('string')) as {
        worksheet?: { sheetData?: { row?: unknown | unknown[] } };
      };

      for (const row of asArray(worksheet.worksheet?.sheetData?.row)) {
        const cells: string[] = [];
        const rowObj = row as Record<string, unknown>;
        for (const cell of asArray(rowObj.c)) {
          const cellObj = cell as Record<string, unknown>;
          const ref = String(cellObj['@_r'] ?? '');
          const type = String(cellObj['@_t'] ?? '');
          const formula = collectText(cellObj.f);
          const rawValue = collectText(cellObj.v);
          const value = type === 's'
            ? sharedStrings[Number(rawValue)] ?? rawValue
            : type === 'inlineStr'
              ? collectText(cellObj.is)
              : type === 'b'
                ? rawValue === '1' ? 'TRUE' : 'FALSE'
                : rawValue;
          const display = formula ? `${value} [formula: ${formula}]` : value;
          if (ref && display !== '') cells.push(`${ref}: ${display}`);
        }
        if (cells.length > 0) output.push(cells.join(' | '));
      }
      output.push('');
    }

    return {
      text: output.join('\n').trim(),
      extractMethod: 'text',
    };
  }
}

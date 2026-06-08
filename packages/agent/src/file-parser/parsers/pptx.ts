/**
 * pptx parser - .pptx (Office Open XML)
 *
 * .pptx is a ZIP archive with:
 *   - ppt/slides/slide{N}.xml: per-slide content
 *   - ppt/slides/_rels/slide{N}.xml.rels: image relationships
 *   - ppt/media/*: image binaries
 *
 * Output mirrors Python sidecar's PptxParser: each slide is preceded by
 * a "--- Slide N ---" header so consumers can still recover structure.
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { RawParse } from '../types.js';

const REL_TYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  removeNSPrefix: false,
});

interface OpcRelationship {
  Id: string;
  Type: string;
  Target: string;
}

interface OpcRels {
  Relationships?: {
    Relationship?: OpcRelationship | OpcRelationship[];
  };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Walk XML subtree and concatenate all <a:t> text nodes.
 *
 * fast-xml-parser (with removeNSPrefix: false) wraps text in
 * `{"#text": "...", "@_attr": "..."}` objects, so we unwrap those
 * explicitly.
 */
function collectText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  let out = '';
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'a:t') {
      if (typeof value === 'string') {
        out += value;
      } else if (value && typeof value === 'object') {
        const text = (value as Record<string, unknown>)['#text'];
        if (typeof text === 'string') out += text;
      }
    } else if (value && typeof value === 'object') {
      out += collectText(value);
    } else if (Array.isArray(value)) {
      for (const v of value) out += collectText(v);
    }
  }
  return out;
}

export class PptxParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    // Find slide files in order
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)?.[1] ?? '0', 10);
        const nb = parseInt(b.match(/slide(\d+)/)?.[1] ?? '0', 10);
        return na - nb;
      });

    const slidesText: string[] = [];
    const images: Array<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; page: number }> = [];

    for (const slidePath of slideFiles) {
      const slideNum = parseInt(slidePath.match(/slide(\d+)/)?.[1] ?? '0', 10);
      const slideEntry = zip.file(slidePath);
      if (!slideEntry) continue;
      const slideXml = await slideEntry.async('string');
      const slide = xmlParser.parse(slideXml);
      const slideParts: string[] = [`--- Slide ${slideNum} ---`];

      // Find the spTree containing all shapes
      const spTree = slide?.['p:sld']?.['p:cSld']?.['p:spTree'];
      if (spTree) {
        for (const shape of asArray(spTree['p:sp'])) {
          const txBody = (shape as Record<string, unknown>)['p:txBody'];
          if (txBody) {
            const text = collectText(txBody).trim();
            if (text) slideParts.push(text);
          }
          // Pictures are siblings of sp, named p:pic
        }
        // Tables
        for (const graphicFrame of asArray(spTree['p:graphicFrame'])) {
          const table = (graphicFrame as Record<string, unknown>)['a:tbl'];
          if (table) {
            for (const tr of asArray((table as Record<string, unknown>)['a:tr'])) {
              const cells: string[] = [];
              for (const tc of asArray((tr as Record<string, unknown>)['a:tc'])) {
                cells.push(collectText(tc).trim());
              }
              const row = cells.filter((c) => c.length > 0).join(' | ');
              if (row) slideParts.push(row);
            }
          }
        }
      }

      slidesText.push(slideParts.join('\n'));

      // Image relationships for this slide
      const relsPath = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
      const relsEntry = zip.file(relsPath);
      if (!relsEntry) continue;
      const relsXml = await relsEntry.async('string');
      const rels = xmlParser.parse(relsXml) as OpcRels;
      for (const rel of asArray(rels.Relationships?.Relationship)) {
        if (!rel.Type?.includes(REL_TYPE_IMAGE)) continue;
        // Targets in slide rels are relative to ppt/slides/, but
        // typically point to ../media/* which resolves to ppt/media/*
        const targetPath = rel.Target.startsWith('/')
          ? rel.Target.slice(1)
          : `ppt/slides/${rel.Target}`.replace(/\/\.\.\//g, '/../');
        // Normalize "../media/foo" -> "ppt/media/foo"
        const normalized = targetPath.startsWith('ppt/')
          ? targetPath
          : targetPath.replace(/^(?:\.\.\/)+/, 'ppt/');
        const part = zip.file(normalized);
        if (!part) continue;
        const data = await part.async('base64');
        const ext = normalized.split('.').pop()?.toLowerCase() ?? 'png';
        const mediaType = (
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'gif' ? 'image/gif' :
          ext === 'webp' ? 'image/webp' :
          'image/png'
        );
        images.push({
          base64: data,
          mediaType: mediaType as 'image/png',
          page: slideNum - 1, // 0-indexed
        });
      }
    }

    const text = slidesText.join('\n\n');
    let extractMethod: RawParse['extractMethod'];
    if (text.trim() && images.length > 0) extractMethod = 'hybrid';
    else if (images.length > 0) extractMethod = 'vision';
    else extractMethod = 'text';

    return {
      text,
      images: images.length > 0 ? images : undefined,
      extractMethod,
      pageCount: slideFiles.length,
    };
  }
}

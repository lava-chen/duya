/**
 * docx parser - .docx (Office Open XML)
 *
 * .docx is a ZIP archive with:
 *   - word/document.xml: paragraphs and tables
 *   - word/_rels/document.xml.rels: relationships to images
 *   - word/media/*: image binaries
 *
 * We extract paragraph text, table rows, and inline images. Styles and
 * formatting are dropped — only the visible text stream is captured.
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { RawParse } from '../types.js';

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  // Preserve namespace prefixes; we'll match by tag suffix
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

interface DocumentXml {
  'w:document'?: {
    'w:body'?: {
      'w:p'?: unknown | unknown[];
      'w:tbl'?: unknown | unknown[];
    };
  };
}

/** Walk an XML element and concatenate all <w:t> text nodes.
 *
 * fast-xml-parser (with removeNSPrefix: false) wraps text in
 * `{"#text": "...", "@_attr": "..."}` objects, so we unwrap those
 * explicitly. Also handles `w:tab` / `w:br` for paragraph breaks.
 */
function collectText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  let out = '';
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:t') {
      if (typeof value === 'string') {
        out += value;
      } else if (value && typeof value === 'object') {
        const text = (value as Record<string, unknown>)['#text'];
        if (typeof text === 'string') out += text;
      }
    } else if (key === 'w:tab' && value != null) {
      out += '\t';
    } else if (key === 'w:br' && value != null) {
      out += '\n';
    } else if (value && typeof value === 'object') {
      // Recurse into children; tags like w:r, w:p, w:tc all wrap w:t
      out += collectText(value);
    } else if (Array.isArray(value)) {
      for (const v of value) out += collectText(v);
    }
  }
  return out;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export class DocxParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(buffer);

    // --- Text from word/document.xml ---
    const documentEntry = zip.file('word/document.xml');
    if (!documentEntry) {
      throw new Error('Invalid .docx: missing word/document.xml');
    }
    const documentXml = await documentEntry.async('string');
    const doc = xmlParser.parse(documentXml) as DocumentXml;
    const body = doc['w:document']?.['w:body'] ?? {};

    const paragraphs: string[] = [];

    // Document order matters: paragraphs and tables interleave at body level.
    // fast-xml-parser preserves order, so we treat body children as a sequence.
    for (const [key, value] of Object.entries(body)) {
      if (key === 'w:p') {
        for (const p of asArray(value)) {
          const text = collectText(p).trim();
          if (text) paragraphs.push(text);
        }
      } else if (key === 'w:tbl') {
        for (const tbl of asArray(value)) {
          for (const tr of asArray((tbl as Record<string, unknown>)['w:tr'])) {
            const cells: string[] = [];
            for (const tc of asArray((tr as Record<string, unknown>)['w:tc'])) {
              cells.push(collectText(tc).trim());
            }
            const row = cells.filter((c) => c.length > 0).join(' | ');
            if (row) paragraphs.push(row);
          }
        }
      }
    }

    const text = paragraphs.join('\n\n');

    // --- Images from word/media + relationships ---
    const images: Array<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }> = [];
    const relsEntry = zip.file('word/_rels/document.xml.rels');
    if (relsEntry) {
      const relsXml = await relsEntry.async('string');
      const rels = xmlParser.parse(relsXml) as OpcRels;
      const relationships = asArray(rels.Relationships?.Relationship);

      for (const rel of relationships) {
        if (!rel.Type?.includes(REL_TYPE_IMAGE)) continue;
        // Target is relative to the rels file's source (word/),
        // so "media/image1.png" maps to "word/media/image1.png"
        const targetPath = rel.Target.startsWith('/')
          ? rel.Target.slice(1)
          : `word/${rel.Target}`;
        const part = zip.file(targetPath);
        if (!part) continue;
        const data = await part.async('base64');
        const ext = targetPath.split('.').pop()?.toLowerCase() ?? 'png';
        const mediaType = (
          ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
          ext === 'gif' ? 'image/gif' :
          ext === 'webp' ? 'image/webp' :
          'image/png'
        );
        images.push({
          base64: data,
          mediaType: mediaType as 'image/png',
        });
      }
    }

    let extractMethod: RawParse['extractMethod'];
    if (text.trim() && images.length > 0) extractMethod = 'hybrid';
    else if (images.length > 0) extractMethod = 'vision';
    else extractMethod = 'text';

    return {
      text,
      images: images.length > 0 ? images : undefined,
      extractMethod,
    };
  }
}

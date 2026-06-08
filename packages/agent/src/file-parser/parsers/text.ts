/**
 * text parser - .txt, .md, and any other plain text
 *
 * Reads with utf-8 and `errors: 'replace'` (matches Python sidecar's
 * TxtParser) so we never crash on bad encoding. No thumbnail, no images.
 */

import { readFile } from 'node:fs/promises';
import type { RawParse } from '../types.js';

export class TextParser {
  async parse(filePath: string): Promise<RawParse> {
    const text = await readFile(filePath, { encoding: 'utf-8', flag: 'r' });
    // Strip BOM if present
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return {
      text: clean,
      extractMethod: 'text',
    };
  }
}

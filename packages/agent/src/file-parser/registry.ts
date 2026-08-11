/**
 * ParserRegistry - extension -> Parser factory
 *
 * Lightweight registry that defers parser construction to first use.
 * TextParser and DocumentParser are constructed on the spot; heavier
 * parsers (docx/pptx/pdf) are also lightweight classes but we keep
 * the factory pattern for future caching.
 *
 * Image files are NOT registered here. The ReadTool routes image files
 * to the dedicated vision_analyze tool instead of parsing pixels.
 */

import { TextParser } from './parsers/text.js';
import { DocxParser } from './parsers/docx.js';
import { PptxParser } from './parsers/pptx.js';
import { PdfParser } from './parsers/pdf.js';
import { NotebookParser } from './parsers/notebook.js';
import { XlsxParser } from './parsers/xlsx.js';
import type { RawParse } from './types.js';

export interface Parser {
  parse(filePath: string): Promise<RawParse>;
}

export type ParserFactory = () => Parser;

export const REGISTRY: Record<string, ParserFactory> = {
  '.txt': () => new TextParser(),
  '.md': () => new TextParser(),
  '.docx': () => new DocxParser(),
  '.pptx': () => new PptxParser(),
  '.xlsx': () => new XlsxParser(),
  '.pdf': () => new PdfParser(),
  '.ipynb': () => new NotebookParser(),
};

export function getParser(ext: string): Parser | null {
  const factory = REGISTRY[ext.toLowerCase()];
  return factory ? factory() : null;
}

export function listSupportedExtensions(): string[] {
  return Object.keys(REGISTRY);
}

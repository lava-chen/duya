/**
 * ParserRegistry - extension -> Parser factory
 *
 * Lightweight registry that defers parser construction to first use.
 * TextParser and ImageParser are constructed on the spot; heavier
 * parsers (docx/pptx/pdf) are also lightweight classes but we keep
 * the factory pattern for future caching.
 */

import { TextParser } from './parsers/text.js';
import { DocxParser } from './parsers/docx.js';
import { PptxParser } from './parsers/pptx.js';
import { PdfParser } from './parsers/pdf.js';
import { ImageParser } from './parsers/image.js';
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
  '.pdf': () => new PdfParser(),
  '.png': () => new ImageParser(),
  '.jpg': () => new ImageParser(),
  '.jpeg': () => new ImageParser(),
  '.gif': () => new ImageParser(),
  '.webp': () => new ImageParser(),
};

export function getParser(ext: string): Parser | null {
  const factory = REGISTRY[ext.toLowerCase()];
  return factory ? factory() : null;
}

export function listSupportedExtensions(): string[] {
  return Object.keys(REGISTRY);
}

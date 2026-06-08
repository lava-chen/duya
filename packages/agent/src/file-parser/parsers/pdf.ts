/**
 * pdf parser - .pdf text extraction with vision fallback
 *
 * Strategy mirrors the Python sidecar (pdf_parser.py):
 *   1. Use pdf-parse (pdfjs-dist based) to extract text per page
 *   2. Compute avg chars per page
 *   3. If total chars == 0  -> full vision fallback (rasterize every page)
 *   4. If avg < 50 && pages <= 5  -> hybrid (text + rasterized images)
 *   5. Otherwise  -> text only
 *
 * Vision fallback delegates to pdfVision.ts which uses poppler-utils.
 */

import { readFile } from 'node:fs/promises';
// pdf-parse is CJS. Static import gives us the default function and
// lets vitest's module mocking intercept the call in tests.
import pdfParse from 'pdf-parse';
import type { RawParse } from '../types.js';
import { PDF_CONFIDENCE_THRESHOLD, PDF_HYBRID_MAX_PAGES } from '../types.js';
import { detectPoppler } from '../poppler.js';
import { rasterizePages, getPageCount } from './pdf-vision.js';

export class PdfParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    const parsed = await pdfParse(buffer);
    const pageCount = parsed.numpages || 0;
    const text = parsed.text ?? '';
    const totalChars = text.length;
    const avgCharsPerPage = pageCount > 0 ? totalChars / pageCount : 0;

    if (totalChars === 0) {
      // Fully scanned document — try vision fallback
      return this.visionFallback(filePath, pageCount, 'vision');
    }

    if (avgCharsPerPage < PDF_CONFIDENCE_THRESHOLD / 2 && pageCount <= PDF_HYBRID_MAX_PAGES) {
      // Low confidence on a small doc — hybrid
      const images = await this.tryRasterize(filePath, pageCount);
      return {
        text,
        images,
        extractMethod: images.length > 0 ? 'hybrid' : 'text',
        pageCount,
      };
    }

    return {
      text,
      extractMethod: 'text',
      pageCount,
    };
  }

  private async visionFallback(
    filePath: string,
    pageCount: number,
    method: 'vision' | 'hybrid',
  ): Promise<RawParse> {
    const images = await this.tryRasterize(filePath, pageCount);
    return {
      text: '',
      ...(images.length > 0 && { images }),
      extractMethod: images.length > 0 ? method : 'text',
      pageCount,
    };
  }

  private async tryRasterize(
    filePath: string,
    pageCount: number,
  ): Promise<Array<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; page: number }>> {
    if (pageCount === 0) {
      // We don't know the page count from text extraction; ask pdfinfo
      const poppler = await detectPoppler();
      if (!poppler.pdfinfo) return [];
      pageCount = (await getPageCount(filePath, poppler.pdfinfo)) ?? 0;
      if (pageCount === 0) return [];
    }

    const poppler = await detectPoppler();
    if (!poppler.pdftoppm) return [];

    return rasterizePages(filePath, poppler.pdftoppm, pageCount);
  }
}

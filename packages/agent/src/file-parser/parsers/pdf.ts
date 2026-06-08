/**
 * pdf parser - .pdf text extraction with vision fallback
 *
 * Three-tier strategy that mirrors the Python sidecar's intent while
 * fixing three real-world failure modes:
 *
 *   1. Hard errors. pdf-parse v1 (pdfjs v1.10.100) crashes on some
 *      PDFs with "FormatError: Illegal character". We catch the
 *      failure and fall through to vision.
 *   2. Garbled text. PDFs using CID fonts without a proper
 *      ToUnicode CMap (the most common case for CJK + scanned
 *      forms) extract as the U+FFFD replacement character
 *      and other Latin-1 noise. Each such char counts as 1 token,
 *      so a 9000-line PDF can blow the 25K budget with no useful
 *      content. We detect high replacement-character rates and
 *      demote the document to vision.
 *   3. Low confidence. avgCharsPerPage below the threshold
 *      suggests a scanned document; we rasterize it (if poppler is
 *      available) and feed images to the model instead.
 *
 *   text    -> usable text extracted, no images
 *   vision  -> empty text, page images only (scanned / garbled / errored)
 *   hybrid  -> both (small low-confidence docs keep the partial
 *                text alongside the page images as a fallback)
 */

import { readFile } from 'node:fs/promises';
// pdf-parse is CJS. Static import gives us the default function and
// lets vitest's module mocking intercept the call in tests.
import pdfParse from 'pdf-parse';
import type { RawParse } from '../types.js';
import { PDF_CONFIDENCE_THRESHOLD, PDF_HYBRID_MAX_PAGES } from '../types.js';
import { detectPoppler } from '../poppler.js';
import { rasterizePages, rasterizeThumbnail, getPageCount } from './pdf-vision.js';

/**
 * Replacement characters and unassigned code points that signal a
 * CMap or font-encoding failure. A high density of these in the
 * extracted text is a strong indicator that the PDF is unusable as
 * text and should be demoted to vision.
 */
const REPLACEMENT_CHARS = new Set([
  '�',          // U+FFFD REPLACEMENT CHARACTER
  '?',          // U+003F (often a stand-in for unmappable chars)
  '',           // U+0000 NULL
  '￾',     // BOM / noncharacter
  '￿',     // noncharacter
]);

/**
 * What fraction of the extracted text consists of replacement
 * characters. The 0.20 threshold is conservative — even a fully
 * CJK PDF (where no Latin-1 char is meaningful) shouldn't have
 * 20% of its output be `?` or `�`. This catches CID font and
 * ToUnicode failures without false-positiving on short, plain-text
 * documents that happen to contain a few `?`s.
 */
const REPLACEMENT_RATIO_THRESHOLD = 0.20;

function replacementRatio(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const ch of text) {
    if (REPLACEMENT_CHARS.has(ch)) count++;
  }
  return count / text.length;
}

interface PdfParseOk {
  ok: true;
  numpages: number;
  text: string;
}

interface PdfParseErr {
  ok: false;
  error: string;
}

type PdfParseResult = PdfParseOk | PdfParseErr;

/**
 * Wraps pdf-parse so a hard error (FormatError, etc.) becomes a
 * typed result instead of an exception. We never let pdf-parse
 * exceptions propagate — every failure mode is recoverable.
 */
async function safeParse(buffer: Buffer): Promise<PdfParseResult> {
  try {
    const parsed = await pdfParse(buffer);
    return {
      ok: true,
      numpages: parsed.numpages || 0,
      text: parsed.text ?? '',
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class PdfParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    const result = await safeParse(buffer);

    // Always try to render a first-page thumbnail for the UI preview.
    // Independent of which branch we end up in below — the user
    // should see a preview even when text extraction fails. Returns
    // null if poppler is missing or the file is unreadable.
    const thumbnail = await this.renderThumbnailSafe(filePath);

    // Hard error from pdf-parse: skip text entirely, try vision
    if (!result.ok) {
      const knownCount = await this.getPageCountSafe(filePath);
      return this.visionFallback(filePath, knownCount ?? 0, 'vision', thumbnail);
    }

    const pageCount = result.numpages;
    const text = result.text;
    const totalChars = text.length;
    const avgCharsPerPage = pageCount > 0 ? totalChars / pageCount : 0;

    // No text at all -> scanned document, full vision
    if (totalChars === 0) {
      return this.visionFallback(filePath, pageCount, 'vision', thumbnail);
    }

    // High replacement-char ratio -> CMap/CID failure, demote to vision
    // Catches the "9000 lines of `?`" failure mode that the original
    // Python sidecar silently passed through as text.
    if (replacementRatio(text) >= REPLACEMENT_RATIO_THRESHOLD) {
      return this.visionFallback(filePath, pageCount, 'vision', thumbnail);
    }

    // Low confidence on a small doc: keep the partial text, also
    // add images (the model can reconcile both).
    if (avgCharsPerPage < PDF_CONFIDENCE_THRESHOLD / 2 && pageCount <= PDF_HYBRID_MAX_PAGES) {
      const images = await this.tryRasterize(filePath, pageCount);
      return {
        text,
        ...(images.length > 0 && { images }),
        ...(thumbnail && { thumbnail }),
        extractMethod: images.length > 0 ? 'hybrid' : 'text',
        pageCount,
      };
    }

    return {
      text,
      ...(thumbnail && { thumbnail }),
      extractMethod: 'text',
      pageCount,
    };
  }

  private async visionFallback(
    filePath: string,
    pageCount: number,
    method: 'vision' | 'hybrid',
    thumbnail?: { base64: string; mediaType: 'image/png' } | null,
  ): Promise<RawParse> {
    const images = await this.tryRasterize(filePath, pageCount);
    return {
      text: '',
      ...(images.length > 0 && { images }),
      ...(thumbnail && { thumbnail }),
      extractMethod: images.length > 0 ? method : 'text',
      pageCount,
    };
  }

  private async renderThumbnailSafe(
    filePath: string,
  ): Promise<{ base64: string; mediaType: 'image/png' } | null> {
    try {
      const poppler = await detectPoppler();
      if (!poppler.pdftoppm) return null;
      return await rasterizeThumbnail(filePath, poppler.pdftoppm);
    } catch {
      return null;
    }
  }

  private async tryRasterize(
    filePath: string,
    pageCount: number,
  ): Promise<Array<{ base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; page: number }>> {
    if (pageCount === 0) {
      const knownCount = await this.getPageCountSafe(filePath);
      if (!knownCount) return [];
      pageCount = knownCount;
    }

    const poppler = await detectPoppler();
    if (!poppler.pdftoppm) return [];

    return rasterizePages(filePath, poppler.pdftoppm, pageCount);
  }

  private async getPageCountSafe(filePath: string): Promise<number | null> {
    try {
      const poppler = await detectPoppler();
      if (!poppler.pdfinfo) return null;
      return await getPageCount(filePath, poppler.pdfinfo);
    } catch {
      return null;
    }
  }
}

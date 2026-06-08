/**
 * NodeFileParser - types
 *
 * Mirrors the JSON shape produced by the legacy Python sidecar
 * (electron/services/document-parser/sidecar/main.py) so the IPC layer
 * and frontend can stay unchanged during the cutover.
 */

export type ExtractMethod = 'text' | 'vision' | 'hybrid';

export interface TextChunk {
  type: 'text';
  index: number;
  text: string;
}

export interface ImageChunk {
  type: 'image';
  index: number;
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** 0-indexed page number for PDF, slide number for PPTX, undefined for DOCX/inline images */
  page?: number;
}

export type ParseChunk = TextChunk | ImageChunk;

export interface ThumbnailData {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface ParseResult {
  fileHash: string;
  sessionId: string;
  filename: string;
  charCount: number;
  chunks: ParseChunk[];
  extractMethod: ExtractMethod;
  /** Number of pages in the source document (PDF/PPTX), if known. */
  pageCount?: number;
  thumbnail?: ThumbnailData;
  parsedAt: number;
}

export interface RawParse {
  text: string;
  images?: Array<{ base64: string; mediaType: ImageChunk['mediaType']; page?: number }>;
  thumbnail?: ThumbnailData;
  extractMethod: ExtractMethod;
  pageCount?: number;
}

export interface ParseOptions {
  /** Optional page range for PDF/DOCX-style, e.g. "1-5" */
  pages?: string;
  /** Max image chunk count (safety cap to avoid OOM on huge docs) */
  maxImageChunks?: number;
  /** Thumbnail max width in pixels (default 300) */
  thumbnailMaxWidth?: number;
}

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const PARSE_TIMEOUT_MS = 30_000; // 30s
export const MAX_CONCURRENT = 2;

/** PDF text extraction confidence gate (chars per page) */
export const PDF_CONFIDENCE_THRESHOLD = 100;

/** PDF vision fallback triggers at half the threshold AND few pages */
export const PDF_HYBRID_MAX_PAGES = 5;

/** Hard cap on PDF pages to render as images (matches Python sidecar) */
export const PDF_VISION_MAX_PAGES = 50;

/** Default text chunk size for chunker (matches registry.py: 4000 chars) */
export const TEXT_CHUNK_MAX_SIZE = 4000;
/** Default chunk overlap (matches registry.py: 200 chars) */
export const TEXT_CHUNK_OVERLAP = 200;

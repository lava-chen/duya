/**
 * NodeFileParser - main entry point
 *
 * Replaces the Python sidecar in `electron/services/document-parser/`
 * for the main path. Same input/output JSON shape so the IPC layer and
 * frontend don't change.
 *
 * Usage:
 *   const parser = new NodeFileParser({ sessionId: 'default' });
 *   const result = await parser.parseFile('/path/to/file.pdf', abortSignal);
 *   // result: ParseResult (chunks, thumbnail, extractMethod, ...)
 */

import { basename, extname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { computeFileHash, createParseCache, type ParseCache } from './cache.js';
import { chunkText } from './chunker.js';
import { getParser, listSupportedExtensions, type Parser } from './registry.js';
import { WorkerPool } from './worker-pool.js';
import { detectPoppler, type PopplerInfo } from './poppler.js';
import {
  MAX_FILE_SIZE,
  PARSE_TIMEOUT_MS,
  PDF_CONFIDENCE_THRESHOLD,
  type ImageChunk,
  type ParseChunk,
  type ParseResult,
  type RawParse,
  type TextChunk,
} from './types.js';

export interface NodeFileParserOptions {
  sessionId: string;
  maxFileSize?: number;
  parseTimeoutMs?: number;
  enableCache?: boolean;
  cacheTtlMs?: number;
  maxConcurrent?: number;
}

export interface NodeFileParserCapabilities {
  parsers: Record<string, string>;
  poppler: PopplerInfo;
  version: string;
  supportedExtensions: string[];
}

export class NodeFileParser {
  private readonly sessionId: string;
  private readonly maxFileSize: number;
  private readonly parseTimeoutMs: number;
  private readonly cache: ParseCache | null;
  private readonly pool: WorkerPool;
  private popplerInfo: PopplerInfo | null = null;
  private popplerProbed = false;

  constructor(options: NodeFileParserOptions) {
    this.sessionId = options.sessionId;
    this.maxFileSize = options.maxFileSize ?? MAX_FILE_SIZE;
    this.parseTimeoutMs = options.parseTimeoutMs ?? PARSE_TIMEOUT_MS;
    this.cache = options.enableCache !== false
      ? createParseCache({ ttlMs: options.cacheTtlMs })
      : null;
    this.pool = new WorkerPool({ maxConcurrent: options.maxConcurrent });
  }

  /** Lazily probe poppler once and cache the result. */
  async getPoppler(): Promise<PopplerInfo> {
    if (!this.popplerProbed) {
      this.popplerInfo = await detectPoppler();
      this.popplerProbed = true;
    }
    return this.popplerInfo!;
  }

  async getCapabilities(): Promise<NodeFileParserCapabilities> {
    const poppler = await this.getPoppler();
    return {
      parsers: {
        docx: 'jszip',
        pdf: 'pdf-parse',
        pptx: 'jszip',
        xlsx: 'jszip',
        txt: 'built-in',
        image: 'jimp',
      },
      poppler,
      version: '1.0.0',
      supportedExtensions: listSupportedExtensions(),
    };
  }

  async parseFile(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    this.validateFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const parser = getParser(ext);
    if (!parser) {
      throw new Error(`Unsupported format: ${ext}`);
    }

    const fileHash = computeFileHash(filePath);

    // Cache hit?
    if (this.cache) {
      const cached = this.cache.get(fileHash);
      if (cached) return cached;
    }

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.parseTimeoutMs);

    // Chain user signal -> timeout signal
    const onUserAbort = () => timeoutController.abort();
    if (signal) {
      if (signal.aborted) timeoutController.abort();
      else signal.addEventListener('abort', onUserAbort, { once: true });
    }

    try {
      const raw = await this.pool.run(() => parser.parse(filePath));
      const result = this.toParseResult(raw, filePath, fileHash);
      if (this.cache) this.cache.set(fileHash, result);
      return result;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onUserAbort);
    }
  }

  /** Discard cached results. Useful for tests and session teardown. */
  clearCache(): void {
    this.cache?.clearBySession(this.sessionId);
  }

  dispose(): void {
    this.pool.dispose();
  }

  // --- internals ---

  private validateFile(filePath: string): void {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const stat = statSync(filePath);
    if (stat.size > this.maxFileSize) {
      throw new Error(
        `File exceeds size limit (${this.maxFileSize} bytes): ${filePath}`,
      );
    }
    if (stat.size === 0) {
      throw new Error(`File is empty: ${filePath}`);
    }
  }

  private toParseResult(
    raw: RawParse,
    filePath: string,
    fileHash: string,
  ): ParseResult {
    const text = raw.text ?? '';
    // Parsers that emit pre-chunked text (e.g. NotebookParser) provide
    // raw.chunks. Use those directly so cell-level structure is
    // preserved for the result-builder and downstream consumers like
    // cell_range filtering. Fall back to paragraph chunking otherwise.
    const textChunks: TextChunk[] = raw.chunks && raw.chunks.length > 0
      ? raw.chunks
      : chunkText(text);
    const textChunkCount = textChunks.length;

    const imageChunks: ImageChunk[] = [];
    if (raw.images) {
      for (let i = 0; i < raw.images.length; i++) {
        const img = raw.images[i];
        imageChunks.push({
          type: 'image',
          index: textChunkCount + i,
          base64: img.base64,
          mediaType: img.mediaType,
          ...(img.page !== undefined ? { page: img.page } : {}),
        });
      }
    }

    const chunks: ParseChunk[] = [...textChunks, ...imageChunks];

    const result: ParseResult = {
      fileHash,
      sessionId: this.sessionId,
      filename: basename(filePath),
      charCount: text.length,
      chunks,
      extractMethod: raw.extractMethod,
      parsedAt: Date.now(),
    };
    if (raw.pageCount !== undefined) {
      result.pageCount = raw.pageCount;
    }
    if (raw.thumbnail) {
      result.thumbnail = raw.thumbnail;
    }
    return result;
  }
}

// Re-export constants for downstream code that needs the same thresholds
export { MAX_FILE_SIZE, PARSE_TIMEOUT_MS, PDF_CONFIDENCE_THRESHOLD };
export type { ParseResult, ParseChunk, ImageChunk, TextChunk } from './types.js';
export { computeFileHash, createParseCache } from './cache.js';
export { getParser, listSupportedExtensions } from './registry.js';
export { detectPoppler } from './poppler.js';
export { getFileParserConfig, _resetFileParserConfig } from './config.js';
export { NodeFileParser as default };

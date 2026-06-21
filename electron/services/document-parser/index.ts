/**
 * DocumentParserService - Electron main process wrapper around NodeFileParser
 *
 * Replaces the legacy Python sidecar. The IPC and frontend contracts
 * are preserved (parse / getCapabilities / isReady / start / stop),
 * but the actual parsing now runs in-process via @duya/agent/file-parser.
 *
 * Side benefits:
 *   - No PyInstaller binary, no poppler PATH dependency on the main path
 *   - No stdio JSON-RPC protocol, no restart-on-crash, no spawn overhead
 *   - SHA-256 cache deduplication is shared with ReadTool
 *
 * Legacy .doc fallback:
 *   The Python sidecar source in `electron/services/document-parser/sidecar/`
 *   is retained as an opt-in fallback for users with .doc files that
 *   cannot be converted to .docx. It is NOT built or shipped by default
 *   (see package.json `build:docparser`). The electron-builder `extraResources`
 *   entry for `build/document-parser/` is conditional: missing source
 *   produces a warning, not a build failure. To enable .doc support,
 *   run `npm run build:docparser` before `electron:pack`.
 */

import { app } from 'electron';
import { getLogger, LogComponent } from '../../logging/logger';
import {
  NodeFileParser,
  listSupportedExtensions,
  getFileParserConfig,
  type ParseResult as NodeParseResult,
} from '../../../packages/agent/src/file-parser/index.js';
import type {
  ParseResult,
  Capabilities,
  ParseRequest,
} from './types';

// Re-export the IPC contract so downstream imports keep working
export type { ParseResult, Capabilities } from './types';

const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export class DocumentParserService {
  private parser: NodeFileParser | null = null;
  private capabilities: Capabilities | null = null;
  private disabled = false;
  private logger = getLogger();
  private activeRequests = new Map<number, ParseRequest>();
  private nextId = 1;
  private cache = new Map<string, { result: ParseResult; parsedAt: number }>();

  async start(): Promise<void> {
    const config = getFileParserConfig();
    if (config.disabled) {
      this.disabled = true;
      this.logger.warn(
        'DocumentParserService disabled via DUYA_FILE_PARSER_DISABLED',
        undefined,
        LogComponent.DocumentParser,
      );
      return;
    }

    try {
      this.parser = new NodeFileParser({
        sessionId: 'electron-main',
        parseTimeoutMs: config.parseTimeoutMs,
        cacheTtlMs: config.cacheTtlMs,
        maxConcurrent: config.maxConcurrent,
      });
      const caps = await this.parser.getCapabilities();
      // Translate NodeFileParser capabilities into the legacy shape
      // (preserves frontend expectations: docx = 'jszip', etc.)
      this.capabilities = {
        parsers: {
          // .doc fallback is opt-in: only present when build:docparser
          // was run before electron:pack (see electron-builder.yml).
          // Frontend treats `doc: false` as "show a warning when .doc
          // is dropped into chat".
          doc: false,
          docx: caps.parsers.docx,
          pdf: caps.parsers.pdf,
          pptx: caps.parsers.pptx,
          xlsx: caps.parsers.xlsx,
          txt: caps.parsers.txt,
        },
        // Kept for backward compatibility; always null on the main path
        // (libreoffice is only relevant for the deprecated .doc fallback)
        libreoffice_path: null,
        version: caps.version,
      };
      this.logger.info(
        'DocumentParserService started (NodeFileParser)',
        { capabilities: this.capabilities },
        LogComponent.DocumentParser,
      );
    } catch (error) {
      this.disabled = true;
      this.logger.error(
        'DocumentParserService failed to start',
        error instanceof Error ? error : new Error(String(error)),
        undefined,
        LogComponent.DocumentParser,
      );
    }
  }

  async stop(): Promise<void> {
    // Reject any in-flight requests
    for (const req of this.activeRequests.values()) {
      req.reject(new Error('Document parser service shutting down'));
    }
    this.activeRequests.clear();
    this.parser?.dispose();
    this.parser = null;
  }

  isReady(): boolean {
    return !this.disabled && this.parser !== null && this.capabilities !== null;
  }

  getCapabilities(): Capabilities | null {
    return this.capabilities;
  }

  /**
   * Parse a file.
   *   - filePath: absolute path
   *   - sessionId: scope for the result (caller's session, free-form)
   *   - onProgress: optional progress callback (0..1)
   *
   * Result matches the legacy shape consumed by useDocumentParser +
   * useFileAttachments + the feishu gateway.
   */
  async parse(
    filePath: string,
    sessionId: string,
    onProgress?: (progress: number) => void,
  ): Promise<ParseResult> {
    this.validateFile(filePath);

    const fileHash = this.computeFileHash(filePath);
    const cached = this.cache.get(fileHash);
    if (cached) return cached.result;

    if (this.disabled || !this.parser) {
      throw new Error('Document parser is disabled in this build');
    }

    const id = this.nextId++;

    return new Promise<ParseResult>((resolve, reject) => {
      const request: ParseRequest = {
        id,
        filePath,
        sessionId,
        resolve: (result) => {
          this.cache.set(fileHash, { result, parsedAt: Date.now() });
          this.activeRequests.delete(id);
          // Light GC: keep the cache bounded
          this.evictStale();
          resolve(result);
        },
        reject: (err) => {
          this.activeRequests.delete(id);
          reject(err);
        },
        onProgress,
      };
      this.activeRequests.set(id, request);
      this.dispatch(request);
    });
  }

  private dispatch(request: ParseRequest): void {
    if (!this.parser) {
      request.reject(new Error('Document parser not ready'));
      return;
    }
    // Best-effort progress signal (NodeFileParser doesn't emit per-page
    // progress yet, so we just mark "started")
    request.onProgress?.(0.1);

    this.parser
      .parseFile(request.filePath)
      .then((nodeResult) => {
        request.onProgress?.(1);
        request.resolve(this.toLegacyShape(nodeResult, request.sessionId));
      })
      .catch((err) => {
        request.reject(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private toLegacyShape(
    node: NodeParseResult,
    sessionId: string,
  ): ParseResult {
    // Strip the `page` field from image chunks (legacy schema didn't
    // include it) and add metadata envelope.
    const chunks = node.chunks.map((c) => {
      if (c.type === 'image') {
        return { type: 'image' as const, index: c.index, base64: c.base64, mediaType: c.mediaType };
      }
      return { type: 'text' as const, index: c.index, text: c.text };
    });
    return {
      fileHash: node.fileHash,
      sessionId,
      filename: node.filename,
      charCount: node.charCount,
      chunks,
      extractMethod: node.extractMethod,
      thumbnail: node.thumbnail,
      parsedAt: node.parsedAt,
    };
  }

  // --- internals ---

  private validateFile(filePath: string): void {
    const fs = require('node:fs') as typeof import('node:fs');
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    const path = require('node:path') as typeof import('node:path');
    const { MAX_FILE_SIZE } = require('./types.js') as typeof import('./types.js');
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error('File exceeds size limit (50MB)');
    }
    if (stat.size === 0) {
      throw new Error('File is empty');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!listSupportedExtensions().includes(ext)) {
      throw new Error(`Unsupported format: ${ext}`);
    }
  }

  private computeFileHash(filePath: string): string {
    // Reuse NodeFileParser's hash function for consistency
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const path = require('node:path') as typeof import('node:path');
    const fs = require('node:fs') as typeof import('node:fs');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        hash.update(buffer.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Fallback: hash basename + size only
    }
    hash.update(path.basename(filePath));
    hash.update(fs.statSync(filePath).size.toString());
    return hash.digest('hex');
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.parsedAt > CACHE_MAX_AGE_MS) {
        this.cache.delete(key);
      }
    }
  }
}

let instance: DocumentParserService | null = null;

export function initDocumentParser(): DocumentParserService {
  if (!instance) instance = new DocumentParserService();
  return instance;
}

export function getDocumentParser(): DocumentParserService | null {
  return instance;
}

// Suppress unused-warning for `app` import (kept for parity with the
// legacy implementation; could be used for app.isPackaged branching later)
void app;

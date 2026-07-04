/**
 * useFileParsing.ts - Plan 220 Phase 1.
 *
 * Extracted from the legacy `useFileAttachments.ts` so the new unified
 * `useAttachments` hook can invoke the document-parser pipeline without
 * owning a state carrier. The function returns a Promise that resolves
 * once the parser reports a result (or an error).
 *
 * Kept intentionally small: pure I/O + a callback the caller uses to
 * surface progress.
 */

import { useCallback } from 'react';
import type { FileAttachment } from '@/types/message';

export interface FileParsingResult {
  ok: boolean;
  /** The original placeholder id the caller passed in. Used to update the row in place. */
  placeholderId: string;
  /** Parsed text. Empty string if parse failed or no text chunks. */
  text: string;
  /** Image chunks from vision extraction, if any. */
  imageChunks: Array<{ base64: string; mediaType: string }>;
  /** Thumbnail data URL, if the parser produced one. */
  thumbnail?: string;
  /** Extraction method (text/vision/hybrid) reported by the parser. */
  extractMethod?: 'text' | 'vision' | 'hybrid';
  /** Error message if the parse failed. */
  error?: string;
}

interface ElectronParserApi {
  parse: (filePath: string) => Promise<{
    filename: string;
    chunks: Array<
      | { type: 'text'; index: number; text: string }
      | { type: 'image'; index: number; base64: string; mediaType: string }
    >;
    thumbnail?: { mediaType: string; base64: string };
    extractMethod?: 'text' | 'vision' | 'hybrid';
  } | null>;
}

/**
 * Resolve a real filesystem path for a File. Electron < 32 sets `file.path`,
 * but newer versions require `webUtils.getPathForFile`. This helper covers both.
 *
 * `window.electronAPI` has a global type declared elsewhere (electron
 * preload). We access it through a narrow cast because the existing type
 * only covers the main API surface, not the parser/webUtils extensions
 * that live in plugins.
 */
export function resolveFilePath(file: File): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacyPath = (file as any).path;
  if (legacyPath) return legacyPath as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webUtils = (window as any).electronAPI?.electronWebUtils;
  if (webUtils?.getPathForFile) {
    try {
      return webUtils.getPathForFile(file) as string;
    } catch {
      return '';
    }
  }
  return '';
}

const DOCUMENT_EXTS = new Set(['.docx', '.doc', '.pdf', '.pptx', '.xlsx', '.txt', '.md']);

export function isDocumentFile(filename: string): boolean {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();
  return DOCUMENT_EXTS.has(ext);
}

/**
 * Read a File and return its text contents (best-effort). Used as a
 * fallback in environments without the Electron parser.
 */
export async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Parse a document file via the Electron parser service. Returns a
 * `FileParsingResult` summarizing what came back. On failure, returns
 * an `error` field but never throws — callers should treat the error
 * as user-facing and continue.
 *
 * This function is pure I/O. The caller owns the FileAttachment rows
 * and updates them after the result returns.
 */
export async function parseDocument(
  placeholderId: string,
  filePath: string,
): Promise<FileParsingResult> {
  if (!filePath) {
    return { ok: false, placeholderId, text: '', imageChunks: [], error: '无法获取文件路径' };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser = (window as any).electronAPI?.parser as ElectronParserApi | undefined;
  if (!parser) {
    return { ok: false, placeholderId, text: '', imageChunks: [], error: '文档解析服务未初始化' };
  }
  try {
    const result = await parser.parse(filePath);
    if (!result) {
      return { ok: false, placeholderId, text: '', imageChunks: [], error: '解析服务未返回结果' };
    }
    const textChunks = result.chunks
      .filter((c): c is { type: 'text'; index: number; text: string } => c.type === 'text')
      .map((c) => c.text);
    const text = textChunks.join('\n\n');

    const imageChunks = result.chunks
      .filter(
        (c): c is { type: 'image'; index: number; base64: string; mediaType: string } => c.type === 'image',
      )
      .map((c) => ({ base64: c.base64, mediaType: c.mediaType }));

    const thumbnail = result.thumbnail
      ? `data:${result.thumbnail.mediaType};base64,${result.thumbnail.base64}`
      : undefined;

    return {
      ok: true,
      placeholderId,
      text,
      imageChunks,
      thumbnail,
      extractMethod: result.extractMethod,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return { ok: false, placeholderId, text: '', imageChunks: [], error: errMsg };
  }
}

/**
 * Hook stub — currently exposes only the helpers above. The original
 * `useFileAttachments` parsing logic is now invoked as plain functions,
 * so no React state is needed at this layer.
 */
export function useFileParsing() {
  const parse = useCallback(parseDocument, []);
  return { parse, resolveFilePath, isDocumentFile, readFileAsDataURL };
}

/**
 * Re-export the small subset of legacy `FileAttachment`-related types
 * so this file can stand alone as the new parser API surface.
 */
export type { FileAttachment };
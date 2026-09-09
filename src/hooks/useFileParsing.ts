/**
 * useFileParsing.ts - attachment file helpers.
 *
 * The Electron document-parser sidecar (PDF/Office extraction, Plan 220)
 * was removed from the codebase. What remains here are the small helpers
 * the attachment flow still needs: filesystem path resolution and
 * data-URL reading. Non-image files are attached as-is (path + text when
 * the agent can read them directly); there is no client-side document
 * parsing pipeline anymore.
 */

import type { FileAttachment } from '@/types/message';

/**
 * Resolve a real filesystem path for a File. Electron < 32 sets `file.path`,
 * but newer versions require `webUtils.getPathForFile`. This helper covers both.
 *
 * `window.electronAPI` has a global type declared elsewhere (electron
 * preload). We access it through a narrow cast because the existing type
 * only covers the main API surface, not the webUtils extensions
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

/**
 * Read a File and return it as a data URL (used to inline small files
 * when no filesystem path is available).
 */
export async function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/** Binary office/PDF formats that no longer have client-side extraction. */
const BINARY_DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);

export function isBinaryDocumentFile(filename: string): boolean {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();
  return BINARY_DOC_EXTS.has(ext);
}

/**
 * Hook stub — exposes only the helpers above. The original
 * `useFileAttachments` parsing logic is now invoked as plain functions,
 * so no React state is needed at this layer.
 */
export function useFileParsing() {
  return { resolveFilePath, isBinaryDocumentFile, readFileAsDataURL };
}

/**
 * Re-export the small subset of legacy `FileAttachment`-related types
 * so this file can stand alone as the attachment helper API surface.
 */
export type { FileAttachment };

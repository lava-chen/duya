/**
 * file-url.ts — helpers for `file://` attachment URLs (plan 507 P3).
 *
 * Outbound `SendMessage type:'attachment'` messages may carry a `file://` url
 * pointing at a local file. These helpers detect such urls, convert them back
 * to native paths (for reading the bytes before upload), and infer the
 * platform media type from the file extension via the gateway's shared
 * EXT_MIME_MAP (electron may import gateway sources directly — precedent:
 * gateway-adapters.ts).
 */

import * as path from 'node:path';

import { EXT_MIME_MAP } from '../../packages/gateway/src/utils/mime';

/** Fallback MIME type for extensions absent from EXT_MIME_MAP. */
const DEFAULT_MIME = 'application/octet-stream';

/** True when the url uses the `file://` scheme. */
export function isFileUrl(url: string): boolean {
  return url.startsWith('file://');
}

/**
 * Convert a `file://` URL to a native path.
 *
 * - `file:///C:/x/y.png` → `C:\x\y.png` (Windows drive paths are normalized
 *   win32-style on every platform so behavior is deterministic in tests)
 * - `file:///home/x/y.png` → `/home/x/y.png` (POSIX paths are kept as-is)
 * - The path portion is percent-decoded (`%20` → space)
 *
 * Throws on malformed input: unparseable urls, non-file schemes, remote
 * hosts (UNC paths are out of scope), empty paths, and bad percent-encoding.
 */
export function fileUrlToPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Malformed file URL: ${url}`);
  }
  if (parsed.protocol !== 'file:') {
    throw new Error(`Not a file:// URL: ${url}`);
  }
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') {
    throw new Error(`file:// URL with a remote host is not supported: ${url}`);
  }
  let filePath: string;
  try {
    filePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(`file:// URL has invalid percent-encoding: ${url}`);
  }
  if (filePath === '' || filePath === '/') {
    throw new Error(`file:// URL has no path: ${url}`);
  }
  // Windows drive-letter path: /C:/x/y → C:\x\y.
  if (/^\/[A-Za-z]:/.test(filePath)) {
    return path.win32.normalize(filePath.slice(1));
  }
  return filePath;
}

/**
 * Infer the platform media type from the file extension:
 * image/* → photo, audio/* → voice, video/* → video, else document.
 */
export function mediaTypeForPath(filePath: string): 'photo' | 'voice' | 'video' | 'document' {
  const mime = mimeTypeForPath(filePath);
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('audio/')) return 'voice';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/** Look up the MIME type for a path's extension (EXT_MIME_MAP, with fallback). */
export function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext] ?? DEFAULT_MIME;
}

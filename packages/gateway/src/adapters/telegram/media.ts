/**
 * Media download and handling utilities
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';

const TELEGRAM_FILE_API = 'https://api.telegram.org/file/bot';
const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-telegram-media');
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_INJECT_BYTES = 100 * 1024;

// Telegram's Bot API hard download cap is ~20MB for the public cloud; a local
// Bot API server (bot_api_server option) lifts this to ~2GB. Hermes aligns with
// this: when a local Bot API server is configured, larger files are allowed.
const MAX_DOC_BYTES_LOCAL = 2 * 1024 * 1024 * 1024;

export const SUPPORTED_DOCUMENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.py': 'text/x-python',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
};

export const SUPPORTED_VIDEO_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

export const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

export function ensureCacheDir(): void {
  if (!fs.existsSync(MEDIA_CACHE_DIR)) {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }
}

export function getCacheDir(): string {
  return MEDIA_CACHE_DIR;
}

export function getMimeType(filePath: string, mediaType: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (MIME_TYPES[ext]) return MIME_TYPES[ext];

  switch (mediaType) {
    case 'photo': return 'image/jpeg';
    case 'voice': return 'audio/ogg';
    case 'video': return 'video/mp4';
    default: return 'application/octet-stream';
  }
}

export function isTextDocument(ext: string): boolean {
  return ext in SUPPORTED_DOCUMENT_TYPES;
}

export function isVideoFile(ext: string): boolean {
  return ext in SUPPORTED_VIDEO_TYPES;
}

export function canProcessDocument(ext: string): boolean {
  return isTextDocument(ext) || isVideoFile(ext);
}

export function shouldInjectText(ext: string): boolean {
  return ['.md', '.txt'].includes(ext);
}

export interface DownloadedFile {
  buffer: Buffer;
  filePath: string;
}

/**
 * Effective max download size for a file. When a local Bot API server is set,
 * the cap is lifted from 20MB to 2GB (Hermes parity).
 */
export function allowsLargeFiles(cap: number): boolean {
  return cap >= MAX_DOC_BYTES_LOCAL;
}

export async function downloadFileToCache<T>(
  fileId: string,
  token: string,
  apiCall: <R>(method: string, params: Record<string, unknown>) => Promise<R>,
  opts?: { allowsLargeFiles?: boolean }
): Promise<DownloadedFile | null> {
  try {
    const fileInfo = await apiCall<{ file_path?: string; file_size?: number }>('getFile', {
      file_id: fileId,
    });

    if (!fileInfo.file_path) {
      console.warn(`[Telegram] No file_path returned for file_id: ${fileId}`);
      return null;
    }

    const maxBytes = opts?.allowsLargeFiles ? MAX_DOC_BYTES_LOCAL : MAX_DOC_BYTES;
    if (fileInfo.file_size && fileInfo.file_size > maxBytes) {
      console.warn(`[Telegram] File too large: ${fileInfo.file_size} bytes (max ${maxBytes})`);
      return null;
    }

    const downloadUrl = `${TELEGRAM_FILE_API}${token}/${fileInfo.file_path}`;
    const { proxyFetch } = await import('../../proxy-fetch.js');
    const response = await proxyFetch(downloadUrl, { method: 'GET' });

    if (!response.ok) {
      console.warn(`[Telegram] File download failed: HTTP ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    const ext = path.extname(fileInfo.file_path) || '.bin';
    const cacheFileName = `${Date.now()}_${fileId.replace(/[^a-zA-Z0-9]/g, '_')}${ext}`;
    const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);

    fs.writeFileSync(cachePath, buffer);

    return { buffer, filePath: cachePath };
  } catch (err) {
    console.warn(`[Telegram] Failed to download file ${fileId}:`, err);
    return null;
  }
}

export function injectTextContent(
  downloaded: DownloadedFile,
  originalName: string
): string | null {
  if (downloaded.buffer.length > MAX_TEXT_INJECT_BYTES) {
    return null;
  }

  try {
    const textContent = downloaded.buffer.toString('utf-8');
    const displayName = originalName.replace(/[^\w.\- ]/g, '_');
    return `[Content of ${displayName}]:\n${textContent}`;
  } catch {
    console.warn('[Telegram] Could not decode text file as UTF-8, skipping content injection');
    return null;
  }
}

/**
 * Convert an arbitrary audio file to Telegram's native voice format (Ogg Opus)
 * using ffmpeg. Used so TTS output (typically MP3/Edge-TTS) can be delivered as
 * a native voice bubble rather than a generic document.
 *
 * Returns the converted file path, or the original path when ffmpeg is
 * unavailable or the conversion fails (best-effort fallback).
 */
export function convertToOpus(inputPath: string): Promise<string> {
  return new Promise((resolve) => {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.opus' || ext === '.ogg') {
      resolve(inputPath);
      return;
    }

    const outPath = path.join(MEDIA_CACHE_DIR, `${path.basename(inputPath, ext)}_opus.ogg`);

    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-c:a', 'libopus', '-b:a', '64000', '-f', 'ogg', outPath],
      { timeout: 60_000 },
      (err) => {
        if (err || !fs.existsSync(outPath)) {
          resolve(inputPath);
          return;
        }
        resolve(outPath);
      },
    );
  });
}

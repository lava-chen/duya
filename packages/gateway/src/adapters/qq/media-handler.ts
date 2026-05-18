/**
 * Media handler for QQ adapter
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { proxyFetch } from '../../proxy-fetch.js';
import { getMimeType, getMediaFileType } from './message-utils.js';

const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-qq-media');

export function ensureCacheDir(): void {
  if (!fs.existsSync(MEDIA_CACHE_DIR)) {
    fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
  }
}

export function getCacheDir(): string {
  return MEDIA_CACHE_DIR;
}

export interface DownloadedMedia {
  path: string;
  type: 'image' | 'voice' | 'video' | 'file';
}

export interface QQMediaResult {
  file_info: string;
}

export async function downloadMedia(
  url: string,
  filename: string,
  contentType?: string
): Promise<string | null> {
  try {
    const response = await proxyFetch(url, { method: 'GET' });
    if (!response.ok) {
      console.warn(`[QQ] Media download failed: HTTP ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const ext = path.extname(filename) || '.bin';
    const cacheFileName = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}${ext}`;
    const cachePath = path.join(MEDIA_CACHE_DIR, cacheFileName);

    fs.writeFileSync(cachePath, buffer);
    return cachePath;
  } catch (err) {
    console.warn('[QQ] Failed to download media:', err);
    return null;
  }
}

export function categorizeMedia(
  filename: string,
  contentType?: string
): 'image' | 'voice' | 'video' | 'file' {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const type = contentType ?? '';

  if (type.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    return 'image';
  }
  if (type.startsWith('audio/') || ['.mp3', '.ogg', '.wav', '.m4a', '.amr'].includes(ext)) {
    return 'voice';
  }
  if (type.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)) {
    return 'video';
  }
  return 'file';
}

export function buildMediaPayload(
  mediaType: 'photo' | 'voice' | 'video' | 'document',
  fileInfo: string,
  caption?: string
): string {
  if (caption) {
    return JSON.stringify({ file_info: fileInfo, content: caption });
  }
  return JSON.stringify({ file_info: fileInfo });
}

export function getApiUploadUrl(
  apiBase: string,
  chatType: string,
  targetId: string
): string | null {
  switch (chatType) {
    case 'c2c':
      return `${apiBase}/v2/users/${targetId}/files`;
    case 'group':
      return `${apiBase}/v2/groups/${targetId}/files`;
    case 'channel':
      return `${apiBase}/v2/channels/${targetId}/files`;
    case 'dm':
      return `${apiBase}/v2/dms/${targetId}/files`;
    default:
      return null;
  }
}

export function getApiMessageUrl(
  apiBase: string,
  chatType: string,
  targetId: string
): string | null {
  switch (chatType) {
    case 'c2c':
      return `${apiBase}/v2/users/${targetId}/messages`;
    case 'group':
      return `${apiBase}/v2/groups/${targetId}/messages`;
    case 'channel':
      return `${apiBase}/v2/channels/${targetId}/messages`;
    case 'dm':
      return `${apiBase}/v2/dms/${targetId}/messages`;
    default:
      return null;
  }
}

export function buildMultipartBody(
  filePath: string,
  mediaType: string
): { boundary: string; body: Buffer } {
  const boundary = `----DUYAFormBoundary${Date.now()}`;
  const fileType = getMediaFileType(mediaType);
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = getMimeType(filePath, mediaType);

  const chunks: Buffer[] = [];
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_type"\r\n\r\n${fileType}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file_data"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { boundary, body: Buffer.concat(chunks) };
}
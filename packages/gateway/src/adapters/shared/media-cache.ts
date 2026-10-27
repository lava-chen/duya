/**
 * Shared inbound-media cache for adapters.
 *
 * Inbound media reaches the gateway as bytes (webhook base64, attachment
 * download, encrypted blob) and must leave as a local file path, because the
 * host consumes paths, not buffers. The rules that matter:
 * - every write stays inside a per-platform cache dir under the OS temp dir,
 * - the file name is sanitized (vendor message IDs contain `/` and `:`),
 * - an oversized payload is refused *before* being written to disk,
 * - the MIME/extension pair comes from the shared maps so it cannot drift.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT_MIME_MAP, MIME_EXT_MAP } from '../../utils/mime.js';
import { proxyFetch } from '../../proxy-fetch.js';

export type MediaCategory = 'image' | 'voice' | 'video' | 'file';

export interface CachedMedia {
  path: string;
  name: string;
  mime: string;
  category: MediaCategory;
  size: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Per-platform cache directory, created on first use. */
export function platformCacheDir(platform: string): string {
  const dir = path.join(os.tmpdir(), `duya-${platform.replace(/[^a-z0-9_-]/gi, '_')}-media`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Map a vendor MIME type onto the four buckets the host understands. */
export function categorizeMedia(mime: string, filename?: string): MediaCategory {
  const type = (mime || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/') || type.includes('ogg') || type.includes('opus')) return 'voice';

  // Vendors often report `application/octet-stream`; fall back to the extension.
  const ext = path.extname(filename ?? '').toLowerCase();
  const guessed = EXT_MIME_MAP[ext];
  if (guessed) return categorizeMedia(guessed);
  return 'file';
}

export function extensionForMime(mime: string): string {
  return MIME_EXT_MAP[(mime || '').toLowerCase()] ?? '.bin';
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Persist bytes into the platform cache; returns the on-disk descriptor. */
export function cacheMediaBytes(
  platform: string,
  data: Buffer,
  mime: string,
  options: { nameHint?: string; idHint?: string } = {},
): CachedMedia {
  const category = categorizeMedia(mime, options.nameHint);
  const ext = path.extname(options.nameHint ?? '') || extensionForMime(mime);
  const base = sanitize(options.nameHint ? path.basename(options.nameHint, path.extname(options.nameHint)) : 'media');
  const id = sanitize(options.idHint ?? String(Date.now()));
  const name = `${base}${ext.startsWith('.') ? ext : `.${ext}`}`;
  const filePath = path.join(platformCacheDir(platform), `${id}_${name}`);
  fs.writeFileSync(filePath, data);
  return { path: filePath, name, mime, category, size: data.length };
}

/**
 * Download a remote media URL into the cache. Returns `null` on any failure so
 * a broken attachment never fails the whole inbound message.
 */
export async function fetchMediaToCache(
  platform: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    maxBytes?: number;
    mimeHint?: string;
    nameHint?: string;
    idHint?: string;
    timeoutMs?: number;
  } = {},
): Promise<CachedMedia | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  try {
    const response = await proxyFetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) return null;

    const mime = options.mimeHint || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    return cacheMediaBytes(platform, buffer, mime, {
      nameHint: options.nameHint,
      idHint: options.idHint,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Local file or http(s) URL → bytes, used by outbound media paths. */
export async function readMediaSource(source: string, maxBytes = DEFAULT_MAX_BYTES): Promise<Buffer | null> {
  if (/^https?:\/\//i.test(source)) {
    const cached = await fetchMediaToCache('outbound', source, { maxBytes });
    if (!cached) return null;
    const data = fs.readFileSync(cached.path);
    fs.rmSync(cached.path, { force: true });
    return data;
  }
  try {
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(source);
  } catch {
    return null;
  }
}

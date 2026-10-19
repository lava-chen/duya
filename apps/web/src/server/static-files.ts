import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import * as path from 'node:path';

const INDEX_FILE = 'index.html';
const ASSET_PREFIX = '/assets/';
const ASSET_DIRECTORY = 'assets';
const MAX_STATIC_PATH_LENGTH = 1_024;

/**
 * Self-only policy for the served document and its assets. A Vite build emits
 * external same-origin scripts and stylesheets, so inline script and inline
 * style both stay disallowed; `connect-src 'self'` is what keeps the browser
 * talking to this listener instead of the Host origin.
 */
export const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Extensions a browser build actually emits. An extension outside this table is
 * refused rather than served as an untyped blob, so nothing in the build root
 * becomes reachable by accident.
 */
const MIME_TYPES = new Map<string, string>([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export interface StaticFile {
  readonly kind: 'file';
  readonly canonicalPath: string;
  readonly size: number;
  readonly mimeType: string;
}

export interface StaticRejection {
  readonly kind: 'rejected';
  readonly status: number;
  readonly code: string;
}

export type StaticAsset = StaticFile | StaticRejection;

/**
 * Maps a request path onto a file inside the built bundle.
 *
 * Only two entry points exist: the document at `/` or `/index.html`, and files
 * under `/assets/`. There is no directory listing and no SPA fallback, so an
 * unknown path is a miss rather than a guess. Every filesystem error collapses
 * into the same rejection so the response never reveals whether a path exists.
 */
export async function resolveStaticAsset(root: string, pathname: string): Promise<StaticAsset> {
  const relative = toStaticRelativePath(pathname);
  if (relative === null) return notFound();

  const mimeType = MIME_TYPES.get(path.extname(relative).toLowerCase());
  if (mimeType === undefined) return notFound();

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root);
  } catch {
    return notFound();
  }

  // `join` never reinterprets a segment as a drive or UNC root, and every
  // `realpath` below collapses symlinks, so containment is decided on the
  // canonical path rather than on the request string.
  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(path.join(canonicalRoot, relative));
  } catch {
    return notFound();
  }
  if (!isInsideRoot(canonicalRoot, canonicalTarget)) return notFound();

  let stats;
  try {
    stats = await fs.stat(canonicalTarget);
  } catch {
    return notFound();
  }
  if (!stats.isFile()) return notFound();

  return { kind: 'file', canonicalPath: canonicalTarget, size: stats.size, mimeType };
}

/** Streams a resolved build file, or answers HEAD with headers only. */
export function streamStaticFile(response: ServerResponse, asset: StaticFile, headOnly: boolean): void {
  response.writeHead(200, {
    'content-type': asset.mimeType,
    'content-length': String(asset.size),
    'content-security-policy': STATIC_CONTENT_SECURITY_POLICY,
  });
  if (headOnly) {
    response.end();
    return;
  }
  const stream = createReadStream(asset.canonicalPath);
  const onResponseClose = (): void => { stream.destroy(); };
  response.once('close', onResponseClose);
  stream.once('close', () => response.off('close', onResponseClose));
  // Headers are already sent, so a mid-stream failure can only be cut short.
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function toStaticRelativePath(pathname: string): string | null {
  if (pathname === '/' || pathname === `/${INDEX_FILE}`) return INDEX_FILE;
  if (!pathname.startsWith(ASSET_PREFIX)) return null;

  const encoded = pathname.slice(ASSET_PREFIX.length);
  if (encoded.length === 0 || encoded.length > MAX_STATIC_PATH_LENGTH) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // Decoding is what turns `%2e%2e%2f` into a real traversal, so the segment
  // rules are applied to the decoded form. A backslash is a separator on
  // Windows and a literal on POSIX, so both spellings are refused outright.
  if (decoded.includes('\\') || decoded.includes('\0')) return null;

  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
  }
  // The prefix is re-attached so the resolved path stays inside the assets
  // directory; path.join normalizes the separator for the running platform.
  return `${ASSET_DIRECTORY}/${segments.join('/')}`;
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '' || path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function notFound(): StaticRejection {
  return { kind: 'rejected', status: 404, code: 'not_found' };
}

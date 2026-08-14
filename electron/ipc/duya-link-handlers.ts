import { ipcMain } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';

/**
 * duya-link-handlers.ts
 *
 * Exposes a single `duya:link-preview` IPC that resolves a URL's link
 * metadata (favicon + page title) by fetching the page in the main
 * process (bypassing renderer CORS) and parsing the first chunk of HTML.
 *
 * Results are cached per-origin with a short TTL so repeated links to the
 * same site are served from memory instead of hitting the network again —
 * the renderer's favicon/title lookups are therefore cheap.
 */

export interface LinkPreview {
  favicon?: string;
  title?: string;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 5000;
const HTML_LIMIT_BYTES = 512 * 1024; // only the first 512 KB matter for <head>

const cache = new Map<string, { favicon?: string; title?: string; at: number }>();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchPageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!/html|xml/i.test(contentType)) return null;
    const buf = await res.arrayBuffer();
    const slice = buf.slice(0, HTML_LIMIT_BYTES);
    return new TextDecoder('utf-8', { fatal: false }).decode(slice);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return undefined;
  const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : undefined;
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function extractFavicon(html: string, pageUrl: string): string | undefined {
  // Parse <link rel="icon"|"shortcut icon"|... href="...">. Prefer the
  // first icon link; fall back to the conventional /favicon.ico on the
  // origin when none is declared.
  const tagRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]+)/i);
    const rel = (relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[0] ?? '').toLowerCase();
    if (!rel.includes('icon')) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s>]+)/i);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2];
    if (href) return resolveUrl(href, pageUrl);
  }
  try {
    return new URL('/favicon.ico', pageUrl).href;
  } catch {
    return undefined;
  }
}

export async function resolveLinkPreview(url: string): Promise<LinkPreview> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return {};
  }

  const cached = cache.get(origin);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { favicon: cached.favicon, title: cached.title };
  }

  const html = await fetchPageHtml(url);
  const preview: LinkPreview = {};
  if (html) {
    preview.title = extractTitle(html);
    preview.favicon = extractFavicon(html, url);
  }

  if (preview.title || preview.favicon) {
    cache.set(origin, { ...preview, at: Date.now() });
  }

  if (cache.size > 500) {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.at > TTL_MS) cache.delete(key);
    }
  }

  return preview;
}

export function registerDuyaLinkHandlers(): void {
  ipcMain.handle('duya:link-preview', async (_event, url: string): Promise<LinkPreview> => {
    const logger = getLogger();
    try {
      return await resolveLinkPreview(url);
    } catch (error) {
      logger.error(
        'Link preview failed',
        error instanceof Error ? error : new Error(String(error)),
        { url },
        LogComponent.LinkPreview,
      );
      return {};
    }
  });
  getLogger().info('Registered duya link-preview IPC', undefined, LogComponent.LinkPreview);
}
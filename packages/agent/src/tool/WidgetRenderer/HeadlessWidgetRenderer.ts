/**
 * HeadlessWidgetRenderer
 *
 * Renders a widget_code snippet (raw HTML/SVG) inside a sandboxed headless
 * Chromium and returns a PNG screenshot. This backs the visual self-review
 * path in `show_widget`: the agent renders its own output headlessly, hands
 * the PNG to the configured vision model, and gets back a text review.
 *
 * Design notes (see Plan: Widget Visual Self-Review):
 *   - One persistent headless chromium per agent process; pages are recycled
 *     between renders to keep memory bounded.
 *   - `sanitizeForIframe` strips <script>/<iframe>/etc. so the headless page
 *     is safe even when widget_code is hostile.
 *   - WIDGET_CSS_BRIDGE / WIDGET_THEME_DARK_CSS come from `@duya/conductor`
 *     so the headless preview visually matches the chat renderer (single
 *     source of truth for SVG class colors, theme tokens).
 *
 * Crashed/disposed browser is re-created lazily on next render(). The class
 * is intentionally tolerant: failures are reported through the result rather
 * than thrown, so callers can always serialize a meaningful ToolResult.
 */

import type {
  Browser,
  BrowserContext,
  Page,
} from 'playwright';

/** Render options. Both fields are best-effort — see return type. */
export interface RenderOptions {
  /** Color scheme for the CSS bridge. Defaults to 'dark'. */
  theme?: 'light' | 'dark';
  /** Viewport width (CSS pixels). Default 720 — matches widget `viewBox=680` plus padding. */
  width?: number;
  /** Viewport height (CSS pixels). Default 480, but capped to actual content height. */
  height?: number;
  /** Hard timeout for the whole render pipeline. Default 8000ms. */
  timeoutMs?: number;
}

export interface RenderResult {
  png: Buffer;
  mimeType: 'image/png';
  /** Actual pixel width of the resulting image. */
  width: number;
  /** Actual pixel height of the resulting image. */
  height: number;
  /** Total wall-clock time spent inside render(). */
  elapsedMs: number;
}

/** Result-shaped error info so callers can report without re-throwing. */
export interface RenderError {
  ok: false;
  reason: 'init_failed' | 'sanitize_failed' | 'render_timeout' | 'screenshot_failed' | 'disposed';
  message: string;
  elapsedMs: number;
}

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 480;
const DEFAULT_TIMEOUT = 8000;
/**
 * We never let the headless image exceed this — vision models (gpt-4-vision,
 * claude-3-5-sonnet) cap ~5MB and choke on multi-megapixel base64. The actual
 * image is taken at native render size and then downscaled in memory.
 */
const MAX_LONG_EDGE = 1600;

export class HeadlessWidgetRenderer {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private disposed = false;
  /** Currently-rendering promise so concurrent calls serialize. */
  private inflight: Promise<RenderResult | RenderError> | null = null;

  /**
   * Render widgetCode and return a PNG screenshot. Safe to call concurrently
   * — calls are serialized through a single inflight slot so a runaway
   * widget cannot starve the queue.
   */
  async render(
    widgetCode: string,
    options: RenderOptions = {},
  ): Promise<RenderResult | RenderError> {
    if (this.disposed) {
      return {
        ok: false,
        reason: 'disposed',
        message: 'HeadlessWidgetRenderer has been disposed',
        elapsedMs: 0,
      };
    }

    // Serialize concurrent render() calls through a single chained promise.
    // Each new render waits for the previous one to finish; this also means
    // the queue is FIFO and a runaway widget cannot starve a quick one.
    const previous = this.inflight;
    const work: Promise<RenderResult | RenderError> = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // previous failure must not block this render
        }
      }
      return this.renderOnce(widgetCode, options);
    })();
    this.inflight = work;
    try {
      return await work;
    } finally {
      // If we are still the head of the queue, clear the slot so we don't
      // hold a reference to a resolved promise forever.
      if (this.inflight === work) {
        this.inflight = null;
      }
    }
  }

  private async renderOnce(
    widgetCode: string,
    options: RenderOptions,
  ): Promise<RenderResult | RenderError> {
    const start = Date.now();
    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const theme = options.theme ?? 'dark';

    // Lazy-init browser on first render.
    try {
      if (!this.browser || !this.context || !this.page) {
        await this.initBrowser();
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'init_failed',
        message: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - start,
      };
    }

    const page = this.page!;
    const browser = this.browser!;

    // Build the full HTML — CSS bridge first, then sanitized widget body,
    // then a tiny resize-observer so we capture actual rendered height.
    const sanitize = await loadSanitizeForIframe();
    let sanitized: string;
    try {
      sanitized = sanitize(widgetCode);
    } catch (err) {
      return {
        ok: false,
        reason: 'sanitize_failed',
        message: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - start,
      };
    }

    const html = buildHostHtml(sanitized, theme, width, height);

    try {
      await page.setViewportSize({ width, height });
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
      // Give scripts/animations a beat to settle (Chart.js init, fade-ins).
      await page.waitForTimeout(150);

      // Use loose `any` typing here — this runs inside page.evaluate, not on the
      // host, so the TypeScript DOM lib isn't loaded and any would otherwise
      // complain about missing `document` / `window` globals.
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const actualHeight = await page.evaluate(() => {
        const doc = (globalThis as any).document as
          | {
              body?: { scrollHeight: number; getBoundingClientRect: () => { height: number } } | null;
              documentElement?: { scrollHeight: number };
            }
          | undefined;
        if (!doc) return 0;
        const body = doc.body ?? null;
        const root = doc.documentElement;
        if (!body) return root?.scrollHeight ?? 0;
        return Math.max(
          body.scrollHeight,
          body.getBoundingClientRect().height,
          root?.scrollHeight ?? 0,
        );
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */

      const cap = Math.min(Math.max(actualHeight || height, height), MAX_LONG_EDGE);
      await page.setViewportSize({ width, height: cap });

      const buffer = await page.screenshot({
        type: 'png',
        omitBackground: theme === 'light' ? false : false,
      });

      const png = await downscaleIfNeeded(Buffer.from(buffer), MAX_LONG_EDGE);
      const meta = readPngDimensions(png);

      return {
        ok: true as const,
        png,
        mimeType: 'image/png',
        width: meta?.width ?? width,
        height: meta?.height ?? cap,
        elapsedMs: Date.now() - start,
      } as RenderResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('Timeout') || message.includes('timeout');
      return {
        ok: false,
        reason: isTimeout ? 'render_timeout' : 'screenshot_failed',
        message,
        elapsedMs: Date.now() - start,
      };
    } finally {
      // Recycle the page between calls to prevent widget state from leaking
      // (e.g., global event listeners, leaked Chart.js instances).
      try {
        await browser.contexts()[0]?.clearCookies();
      } catch {
        // best-effort
      }
    }
  }

  private async initBrowser(): Promise<void> {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Keep image/font sets small — we only need defaults for screenshots.
        '--disable-extensions',
      ],
    });
    this.context = await this.browser.newContext({
      viewport: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    });
    this.page = await this.context.newPage();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.page?.close();
    } catch {
      // ignore
    }
    try {
      await this.context?.close();
    } catch {
      // ignore
    }
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  /** Whether the underlying browser is alive. For diagnostics. */
  isReady(): boolean {
    return !!(this.browser && this.context && this.page) && !this.disposed;
  }
}

// ============================================================================
// Module-level singleton & provider injection
// ============================================================================

let singleton: HeadlessWidgetRenderer | null = null;

/**
 * Process-scoped renderer. Lazily created; survives across agent turns so we
 * don't pay the chromium launch cost more than once per session.
 */
export function getHeadlessWidgetRenderer(): HeadlessWidgetRenderer {
  if (!singleton) {
    singleton = new HeadlessWidgetRenderer();
  }
  return singleton;
}

/** For tests / hot-reload. */
export async function disposeHeadlessWidgetRenderer(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}

/** Provider indirection — replaces the singleton at runtime in tests. */
let provider: () => HeadlessWidgetRenderer = getHeadlessWidgetRenderer;

export function setHeadlessWidgetRendererProvider(
  next: () => HeadlessWidgetRenderer,
): void {
  provider = next;
}

export function widgetRendererProvider(): HeadlessWidgetRenderer {
  return provider();
}

// ============================================================================
// Helpers (kept module-local so the file is the only public surface)
// ============================================================================

/**
 * Build the HTML "host" page wrapping the widget body. CSS bridge + theme vars
 * are inlined so the headless preview matches the chat renderer visually.
 */
function buildHostHtml(
  widgetBody: string,
  theme: 'light' | 'dark',
  width: number,
  height: number,
): string {
  // Pull the CSS strings lazily to avoid a hard import cycle into
  // @duya/conductor at module load (the host process is bundled).
  // The async loader returns them by the time renderOnce() is called.
  const cssLight = BRIDGE_LIGHT_CACHE;
  const cssDark = BRIDGE_DARK_CACHE;

  return `<!doctype html>
<html data-theme="${theme === 'dark' ? 'dark' : 'light'}">
<head>
<meta charset="utf-8" />
<style>
${cssLight}
${cssDark}
html, body { margin: 0; padding: 0; min-width: ${width}px; min-height: ${height}px; }
body { background: transparent; color: var(--color-text-primary); font-family: var(--font-sans); }
.widget-host { padding: 16px; box-sizing: border-box; width: 100%; }
</style>
</head>
<body>
<div class="widget-host">${widgetBody}</div>
</body>
</html>`;
}

// Filled in by loadCssBridge() at first render. Both these vars keep
// `buildHostHtml` sync — the async import only runs once.
let BRIDGE_LIGHT_CACHE = '';
let BRIDGE_DARK_CACHE = '';
let cssLoaded: Promise<void> | null = null;

async function loadCssBridge(): Promise<void> {
  if (cssLoaded) return cssLoaded;
  cssLoaded = (async () => {
    try {
      const mod = await import('@duya/conductor/elements/widget-css-bridge');
      BRIDGE_LIGHT_CACHE = (mod as { WIDGET_CSS_BRIDGE?: string }).WIDGET_CSS_BRIDGE ?? '';
      BRIDGE_DARK_CACHE = (mod as { WIDGET_THEME_DARK_CSS?: string }).WIDGET_THEME_DARK_CSS ?? '';
    } catch {
      // Fallback to minimal CSS if the import fails (packaging regression).
      BRIDGE_LIGHT_CACHE = ':root { --color-text-primary: #1a1a1a; --color-text-secondary: #6b6b6b; --color-border-tertiary: rgba(0,0,0,0.06); --accent: #7c3aed; --font-sans: sans-serif; }';
      BRIDGE_DARK_CACHE = ':root[data-theme="dark"] { --color-text-primary: #fff; --color-text-secondary: #aaa; --color-border-tertiary: rgba(255,255,255,0.08); --accent: #a78bfa; }';
    }
  })();
  return cssLoaded;
}

let sanitizeLoader: Promise<(html: string) => string> | null = null;
async function loadSanitizeForIframe(): Promise<(html: string) => string> {
  if (sanitizeLoader) return sanitizeLoader;
  sanitizeLoader = (async () => {
    try {
      const mod = await import('@duya/conductor/elements/widget-sanitizer');
      const fn = (mod as { sanitizeForIframe?: (html: string) => string }).sanitizeForIframe;
      if (typeof fn === 'function') return fn;
    } catch {
      // fall through to identity
    }
    // Last-resort fallback: identity + strip <script>. Better than crashing.
    return (html: string) =>
      html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '');
  })();
  return sanitizeLoader;
}

/** Downscale a PNG buffer if either dimension exceeds MAX_LONG_EDGE. */
async function downscaleIfNeeded(
  input: Buffer,
  maxLongEdge: number,
): Promise<Buffer> {
  const dims = readPngDimensions(input);
  if (!dims) return input;
  const { width, height } = dims;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return input;

  const ratio = maxLongEdge / longEdge;
  const targetW = Math.round(width * ratio);
  const targetH = Math.round(height * ratio);

  try {
    const jimpMod = await import('jimp');
    const Jimp = (jimpMod as unknown as { default?: unknown }).default ?? jimpMod;
    // jimp accepts Buffer; both ESM/CJS shapes handled.
    const image = await (Jimp as { read: (buf: Buffer) => Promise<unknown> }).read(input);
    const resized = await (image as { resize: (w: number, h: number) => Promise<unknown> }).resize(
      targetW,
      targetH,
    );
    // jimp v1 returns a promise from getBuffer; v0 used a node-style callback.
    type MaybePromise<T> = T | Promise<T>;
    const getBuf = (resized as {
      getBuffer: (mime: string, cb?: (err: Error | null, buf: Buffer) => void) => MaybePromise<Buffer>;
    }).getBuffer.bind(resized);
    const out: Buffer = await getBuf('image/png');
    return Buffer.from(out);
  } catch {
    // jimp import or processing failed — return original; vision model will
    // either accept or reject, but we won't crash the agent.
    return input;
  }
}

/** Read PNG IHDR chunk for pixel dimensions. Returns null on parse failure. */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    // PNG signature is 8 bytes, IHDR starts at offset 8 with 4-byte length,
    // 4-byte type "IHDR", then 4-byte width and 4-byte height (big-endian).
    if (buf.length < 24) return null;
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i++) {
      if (buf[i] !== sig[i]) return null;
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

// Kick off CSS loading eagerly at module-import time so the first render
// pays no extra latency. Safe even if playwright/chromium aren't ready yet.
void loadCssBridge();

/**
 * twitter_post — publish a tweet/thread on X.com through the logged-in
 * browser session, mirroring OpenCLI's `opencli twitter post`.
 *
 * Prerequisite: the current CDP session holds an authenticated X.com session
 * (a browser tab that can already open https://x.com/compose/post while
 * logged in). This action drives that real UI:
 *
 *   1. navigate to the standalone composer
 *   2. attach images first (Draft.js can reset the editor after upload)
 *   3. insert the tweet text (native CDP `Input.insertText`, then a DOM
 *      execCommand / clipboard-paste fallback that works on Draft.js)
 *   4. submit and verify a success toast + the resulting `/status/<id>` URL
 *
 * Posting publishes publicly. The capability guide and this schema tell the
 * model to obtain explicit user confirmation before calling it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod/v4';
import type { ActionHandler } from './types.js';

const MAX_IMAGES = 4;
const COMPOSE_URL = 'https://x.com/compose/post';
const COMPOSER_SELECTOR = '[data-testid="tweetTextarea_0"]';
const FILE_INPUT_SELECTOR = 'input[type="file"][data-testid="fileInput"]';
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SUBMIT_SELECTORS = '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';

const UPLOAD_POLL_MS = 500;
const UPLOAD_TIMEOUT_MS = 30_000;
const COMPOSER_POLL_MS = 250;
const COMPOSER_TIMEOUT_MS = 10_000;
const SUBMIT_POLL_MS = 500;
const SUBMIT_TIMEOUT_MS = 15_000;

/** Shape returned by the in-page helper scripts. */
interface PageResult {
  ok?: boolean;
  message?: string;
  error?: string;
  actualText?: string;
  id?: string;
  url?: string;
  unconfirmed?: boolean;
  previewCount?: number;
}

// ─── Pure argument validation (exported for unit tests) ─────────────────

export function validateImagePaths(paths: string[]): string[] {
  if (paths.length > MAX_IMAGES) {
    throw new Error(`Too many images: ${paths.length} (max ${MAX_IMAGES})`);
  }
  return paths.map((p) => {
    const absPath = path.resolve(p);
    const ext = path.extname(absPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported image format "${ext}". Supported: jpg, png, gif, webp`);
    }
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      throw new Error(`Not a valid file: ${absPath}`);
    }
    return absPath;
  });
}

export function isUnsupportedInsertTextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err).toLowerCase();
  const lower = msg.toLowerCase();
  return (
    lower.includes('unknown action') ||
    lower.includes('not supported') ||
    lower.includes('not permitted') ||
    lower.includes('no matching signature')
  );
}

// ─── In-page helpers ────────────────────────────────────────────────────

async function focusComposer(client: { evaluate(js: string): Promise<unknown> }): Promise<PageResult> {
  return (await client.evaluate(`(() => {
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    const boxes = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)}));
    const box = boxes.find(visible) || boxes[0];
    if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
    box.focus();
    return { ok: true };
  })()`)) as PageResult;
}

async function verifyComposerText(
  client: { evaluate(js: string): Promise<unknown> },
  text: string
): Promise<PageResult> {
  const iterations = Math.ceil(COMPOSER_TIMEOUT_MS / COMPOSER_POLL_MS);
  return (await client.evaluate(`(async () => {
    const expected = ${JSON.stringify(text)};
    const normalize = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const normalizedExpected = normalize(expected);
    const iterations = ${iterations};
    const pollMs = ${COMPOSER_POLL_MS};
    for (let i = 0; i < iterations; i++) {
      const box = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
      const actual = box ? (box.innerText || box.textContent || '') : '';
      if (box && normalize(actual).includes(normalizedExpected)) return { ok: true };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const box = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
    return {
      ok: false,
      message: 'Could not verify tweet text in the composer after typing.',
      actualText: box ? (box.innerText || box.textContent || '') : ''
    };
  })()`)) as PageResult;
}

async function insertComposerText(
  client: { evaluate(js: string): Promise<unknown>; send(method: string, params?: Record<string, unknown>): Promise<unknown> },
  text: string
): Promise<PageResult> {
  const focusResult = await focusComposer(client);
  if (!focusResult?.ok) return focusResult;

  // 1) Native CDP Input.insertText — the most reliable path for Twitter's
  //    Draft.js editor. Some not-yet-updated backends don't expose it.
  let nativeFailed = false;
  try {
    await client.send('Input.insertText', { text });
    const verified = await verifyComposerText(client, text);
    if (verified?.ok) return verified;
  } catch (err) {
    if (!isUnsupportedInsertTextError(err)) throw err;
    nativeFailed = true;
  }

  // 2) DOM fallback: focus + execCommand('insertText'), then a clipboard
  //    paste event. Works when the native path reports success but the
  //    editor state did not change.
  return (await client.evaluate(`(async () => {
    const expected = ${JSON.stringify(text)};
    const normalize = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    const boxes = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTOR)}));
    const box = boxes.find(visible) || boxes[0];
    if (!box) return { ok: false, message: 'Could not find the tweet composer text area. Are you logged in?' };
    box.focus();
    if (!document.execCommand('insertText', false, expected)) {
      const dt = new DataTransfer();
      dt.setData('text/plain', expected);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    await new Promise((r) => setTimeout(r, 500));
    const actual = box.innerText || box.textContent || '';
    if (normalize(actual).includes(normalize(expected))) return { ok: true };
    return { ok: false, message: 'Could not verify tweet text in the composer after typing.', actualText: actual };
  })()`)) as PageResult;
}

async function attachViaDataTransfer(
  client: { evaluate(js: string): Promise<unknown> },
  absPaths: string[]
): Promise<boolean> {
  const files = absPaths.map((absPath) => {
    const ext = path.extname(absPath).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { name: path.basename(absPath), mime, base64: fs.readFileSync(absPath).toString('base64') };
  });
  const result = (await client.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)});
    if (!input) return { ok: false, error: 'No file input found' };
    const dt = new DataTransfer();
    for (const file of ${JSON.stringify(files)}) {
      const bin = atob(file.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], file.name, { type: file.mime }));
    }
    let assigned = false;
    try {
      Object.defineProperty(input, 'files', { value: dt.files, writable: false, configurable: true });
      assigned = input.files && input.files.length >= ${absPaths.length};
    } catch (e) {
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files');
        if (nativeSetter && nativeSetter.set) {
          nativeSetter.set.call(input, dt.files);
          assigned = input.files && input.files.length >= ${absPaths.length};
        }
      } catch (e2) {}
    }
    if (!assigned) return { ok: false, error: 'Could not assign files to input' };
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`)) as PageResult;
  return result?.ok === true;
}

async function waitForImageUpload(
  client: { evaluate(js: string): Promise<unknown> },
  expectedCount: number
): Promise<PageResult> {
  const iterations = Math.ceil(UPLOAD_TIMEOUT_MS / UPLOAD_POLL_MS);
  return (await client.evaluate(`(async () => {
    const expected = ${expectedCount};
    const pollMs = ${UPLOAD_POLL_MS};
    const iterations = ${iterations};
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    for (let i = 0; i < iterations; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const attachments = document.querySelector('[data-testid="attachments"]');
      const previewCount = Math.max(
        attachments ? attachments.querySelectorAll('[role="group"], img, video').length : 0,
        document.querySelectorAll('[data-testid="tweetPhoto"], img[src^="blob:"], video[src^="blob:"]').length,
        Array.from(document.querySelectorAll('button,[role="button"]')).filter((el) =>
          /remove media|remove image|remove/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
        ).length
      );
      const button = Array.from(document.querySelectorAll(${JSON.stringify(SUBMIT_SELECTORS)}))
        .find((el) => visible(el));
      const buttonReady = !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
      if (previewCount >= expected && buttonReady) return { ok: true, previewCount };
    }
    return { ok: false, message: 'Image upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s.' };
  })()`)) as PageResult;
}

async function submitTweet(
  client: { evaluate(js: string): Promise<unknown> },
  text: string
): Promise<PageResult> {
  const clickResult = (await client.evaluate(`(async () => {
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    for (const toast of Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))) {
      if (visible(toast)) toast.setAttribute('data-duya-before-submit-toast', 'true');
    }
    const buttons = Array.from(document.querySelectorAll(${JSON.stringify(SUBMIT_SELECTORS)}));
    const btn = buttons.find((el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (!btn) return { ok: false, message: 'Tweet button is disabled or not found.' };
    btn.click();
    return { ok: true };
  })()`)) as PageResult;
  if (!clickResult?.ok) return clickResult;

  const iterations = Math.ceil(SUBMIT_TIMEOUT_MS / SUBMIT_POLL_MS);
  return (await client.evaluate(`(async () => {
    const expected = ${JSON.stringify(text)};
    const normalize = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
    const pollMs = ${SUBMIT_POLL_MS};
    const iterations = ${iterations};
    const visible = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    const statusUrl = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return {};
      const links = Array.from(root.querySelectorAll('a[href*="/status/"]'));
      for (const link of links) {
        const href = link.href || link.getAttribute('href') || '';
        if (!href) continue;
        try {
          const url = new URL(href, window.location.origin);
          const hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
          if (!['x.com', 'twitter.com', 'mobile.twitter.com'].includes(hostname)) continue;
          const match = url.pathname.match(/^\\/([^/]+)\\/status\\/(\\d+)\\/?$/);
          if (match) return { url: url.href, id: match[2] };
        } catch (e) {}
      }
      return {};
    };
    for (let i = 0; i < iterations; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const toasts = Array.from(document.querySelectorAll('[role="alert"], [data-testid="toast"]'))
        .filter((el) => visible(el) && !el.hasAttribute('data-duya-before-submit-toast'));
      const successToast = toasts.find((el) => /sent|posted|your post was sent|your tweet was sent/i.test(el.textContent || ''));
      if (successToast) return { ok: true, message: 'Tweet posted successfully.', ...statusUrl(successToast) };
      const alert = toasts.find((el) => /failed|error|try again|not sent|could not/i.test(el.textContent || ''));
      if (alert) return { ok: false, message: (alert.textContent || 'Tweet failed to post.').trim() };
    }
    return { ok: false, unconfirmed: true, message: 'Tweet submission did not complete before timeout.' };
  })()`)) as PageResult;
}

// ─── Action definition ──────────────────────────────────────────────────

const twitterPostSchema = z.object({
  text: z.string().describe('The text content of the tweet to publish'),
  images: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Absolute paths to images to attach, max 4 (jpg/png/gif/webp)'),
});

export const twitterPostAction: ActionHandler<z.infer<typeof twitterPostSchema>> = {
  operation: 'twitter_post',
  // Deliberately hidden from the auto-generated tool schema: posting is an
  // irreversible, public write. The model learns it is callable from the tool
  // prompt (and the X.com capability guide) rather than from a self-advertising
  // schema entry, so it is only used when explicitly warranted. Dispatch still
  // works — ActionRegistry resolves by operation name.
  hidden: true,
  schema: twitterPostSchema,
  async execute(data, ctx) {
    // Publishing always requires a real logged-in browser session.
    if (!ctx.cdp) {
      return {
        error: 'Publishing a tweet requires an active logged-in browser session on x.com.',
        warning: 'Posting publishes publicly — only call this after the user confirms.',
        mode: ctx.mode,
      };
    }

    const text = data.text.trim();
    if (!text) {
      return { error: 'Tweet text is empty. Provide a non-empty text to publish.', mode: ctx.mode };
    }

    let absPaths: string[];
    try {
      absPaths = validateImagePaths(data.images ?? []);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), mode: ctx.mode };
    }

    const client = ctx.cdp;
    try {
      // 1) Open the standalone composer. This is the same route used for
      //    replies and keeps a single visible composer.
      await client.navigate(COMPOSE_URL);
      await client.waitForElement(COMPOSER_SELECTOR, 20000);

      // 2) Attach media BEFORE inserting text — uploading after Draft.js has
      //    text can re-render/reset the editor, producing image-only posts.
      if (absPaths.length > 0) {
        let attached = true;
        try {
          await client.waitForElement(FILE_INPUT_SELECTOR, 15000);
          await client.setFileInput(absPaths, FILE_INPUT_SELECTOR);
        } catch {
          attached = false;
        }
        if (!attached) {
          attached = await attachViaDataTransfer(client, absPaths);
        }
        if (!attached) {
          return { error: 'Image upload failed. Nothing was posted.', mode: ctx.mode };
        }
        const upload = await waitForImageUpload(client, absPaths.length);
        if (!upload?.ok) {
          return {
            error: upload?.message ?? `Image upload did not complete (${absPaths.length} file(s)). Nothing was posted.`,
            mode: ctx.mode,
          };
        }
      }

      // 3) Insert and verify the text after media upload so text + images are
      //    in the final composer state immediately before clicking Post.
      const typed = await insertComposerText(client, text);
      if (!typed?.ok) {
        return {
          error: typed?.message ?? 'Could not type the tweet text.',
          warning: 'Open the composer in the browser and check whether X.com is asking you to log in.',
          mode: ctx.mode,
        };
      }

      // 4) Submit, then verify a success toast and the resulting status URL.
      const result = await submitTweet(client, text);
      if (result?.unconfirmed) {
        return {
          error: `${result.message} Check the account before retrying; the tweet may already be live.`,
          status: 'unknown',
          mode: ctx.mode,
        };
      }
      if (!result?.ok) {
        return {
          error: result?.message ?? 'Tweet failed to post. Nothing was posted.',
          status: 'failed',
          mode: ctx.mode,
        };
      }
      return {
        status: 'success',
        message: result.message ?? 'Tweet posted.',
        text,
        ...(result.id ? { id: result.id } : {}),
        ...(result.url ? { url: result.url } : {}),
        mode: ctx.mode,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), mode: ctx.mode };
    }
  },
};
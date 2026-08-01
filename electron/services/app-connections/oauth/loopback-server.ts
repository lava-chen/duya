/**
 * Loopback HTTP server for OAuth redirect capture.
 *
 * Plan 312 Phase 1. RFC 8252 §7.3: native apps use loopback redirect
 * (`http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`).
 * We bind only the loopback interface, accept a single callback, validate
 * `state`, then close the server.
 *
 * Security:
 * - Bind to the loopback interface only (no 0.0.0.0 / external interface)
 * - Single-shot: only the first request with matching state is accepted
 * - Hard timeout (default 3 min) cancels the authorization attempt
 * - Port conflicts fall through to the OS-assigned ephemeral port
 * - Query string is consumed for state+code extraction, never logged
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { URL } from 'url';
import { getLogger, LogComponent } from '../../../logging/logger';

const COMPONENT = 'AppConnectionLoopback' as LogComponent;

export interface LoopbackStartOptions {
  /** Path component of the redirect URI (e.g. `/callback`). Must start with `/`. */
  path: string;
  /** CSRF state nonce; mismatched state is rejected. */
  expectedState: string;
  /** Hard timeout in ms; default 3 minutes. */
  timeoutMs?: number;
  /** Preferred port; 0 = OS-assigned ephemeral. */
  preferredPort?: number;
  /**
   * Hostname advertised in the redirect URI. The server always binds to the
   * loopback interface (127.0.0.1) for security; this only changes what the
   * browser and OAuth consent screen display. Defaults to `localhost` so users
   * see a friendly hostname instead of a raw IP.
   */
  host?: string;
}

export interface LoopbackResult {
  /** The port the server actually bound to. Renderer builds the redirect URL from this. */
  port: number;
  /** The full redirect URL the renderer should hand to `shell.openExternal`. */
  redirectUri: string;
  /** Resolves with the auth code on success, or rejects on timeout/state mismatch. */
  waitForCode(): Promise<{ code: string; state: string }>;
  /** Tear down the server and any pending timer. Safe to call multiple times. */
  close(): void;
}

export class LoopbackServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackServerError';
  }
}

export function startLoopbackServer(options: LoopbackStartOptions): Promise<LoopbackResult> {
  const logger = getLogger();
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
  const expectedState = options.expectedState;
  const timeoutMs = options.timeoutMs ?? 3 * 60 * 1000;
  const preferredPort = options.preferredPort ?? 0;
  const host = options.host ?? 'localhost';

  let server: http.Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  let resolveFn: ((value: { code: string; state: string }) => void) | null = null;
  let rejectFn: ((err: Error) => void) | null = null;
  let settled = false;

  const promise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const close = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (server) {
      const s = server;
      server = null;
      s.close().catch(() => {
        // ignore
      });
    }
  };

  server = http.createServer((req, res) => {
    if (settled || !server) {
      res.writeHead(410);
      res.end('gone');
      return;
    }
    if (!req.url) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url, `http://127.0.0.1`);
    } catch {
      res.writeHead(400);
      res.end('bad url');
      return;
    }

    if (parsedUrl.pathname !== path) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const code = parsedUrl.searchParams.get('code');
    const state = parsedUrl.searchParams.get('state');
    const error = parsedUrl.searchParams.get('error');
    const errorDescription = parsedUrl.searchParams.get('error_description');

    if (error) {
      settled = true;
      // Provider pushed an error (e.g. user denied consent). We still
      // show the user a friendly page; the query is NOT logged.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildResultPage({ success: false, message: errorDescription ?? error }));
      rejectFn?.(new LoopbackServerError(`provider error: ${error}`));
      close();
      return;
    }

    if (!code || !state) {
      res.writeHead(400);
      res.end('missing code or state');
      return;
    }

    if (state !== expectedState) {
      settled = true;
      res.writeHead(400);
      res.end('state mismatch');
      // Do not log the state value; just flag the event.
      logger.warn('Loopback redirect rejected: state mismatch', undefined, COMPONENT);
      rejectFn?.(new LoopbackServerError('state mismatch'));
      close();
      return;
    }

    settled = true;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildResultPage({ success: true }));
    resolveFn?.({ code, state });
    close();
  });

  server.on('error', (err) => {
    if (!settled) {
      settled = true;
      rejectFn?.(err instanceof Error ? err : new Error(String(err)));
      close();
    }
  });

  timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectFn?.(new LoopbackServerError(`loopback timed out after ${timeoutMs}ms`));
      close();
    }
  }, timeoutMs);

  return new Promise<LoopbackResult>((resolve, reject) => {
    if (!server) {
      reject(new LoopbackServerError('server not initialized'));
      return;
    }
    server.listen(preferredPort, host, () => {
      const addr = server?.address() as AddressInfo | null;
      if (!addr || typeof addr.port !== 'number') {
        reject(new LoopbackServerError('failed to bind loopback server'));
        close();
        return;
      }
      const port = addr.port;
      resolve({
        port,
        redirectUri: `http://${host}:${port}${path}`,
        waitForCode: () => promise,
        close,
      });
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ResultPageOptions {
  success: boolean;
  message?: string;
}

function buildResultPage(options: ResultPageOptions): string {
  const title = options.success ? 'Authorization Successful' : 'Authorization Denied';
  const headline = options.success ? 'Connected to Duya' : 'Authorization denied';
  const body = options.success
    ? 'You can close this tab and return to Duya.'
    : escapeHtml(options.message ?? 'The authorization request was denied.');
  const checkColor = options.success ? '#22c55e' : '#ef4444';
  const countdownScript = options.success
    ? `<script>
        let remaining = 5;
        const counter = document.getElementById('countdown');
        const tick = () => {
          if (counter) counter.textContent = String(remaining);
          if (remaining <= 0) {
            window.close();
            if (typeof timer !== 'undefined') clearInterval(timer);
          }
          remaining -= 1;
        };
        tick();
        const timer = setInterval(tick, 1000);
        document.getElementById('close-btn').addEventListener('click', () => window.close());
      </script>`
    : `<script>
        document.getElementById('close-btn').addEventListener('click', () => window.close());
      </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      --bg: #ffffff;
      --fg: #1a1a1a;
      --muted: #6b6b6b;
      --surface: #f7f7f7;
      --accent: #7c3aed;
      --border: rgba(0, 0, 0, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #1e1e1e;
        --fg: #ffffff;
        --muted: #8a8a8a;
        --surface: #2c2c2c;
        --accent: #a78bfa;
        --border: rgba(255, 255, 255, 0.08);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      padding: 24px;
    }
    .card {
      max-width: 420px;
      width: 100%;
      text-align: center;
      padding: 40px 32px;
      border-radius: 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${options.success ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)'};
    }
    .icon svg {
      width: 32px;
      height: 32px;
      stroke: ${checkColor};
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    p {
      margin: 0 0 20px;
      font-size: 15px;
      line-height: 1.55;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .close-btn {
      appearance: none;
      border: none;
      border-radius: 10px;
      padding: 10px 18px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      color: #ffffff;
      background: var(--accent);
      transition: opacity 0.15s ease;
    }
    .close-btn:hover { opacity: 0.92; }
    .close-btn:active { opacity: 0.86; }
    .countdown {
      font-size: 13px;
      color: var(--muted);
    }
    .brand {
      margin-top: 28px;
      font-size: 13px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.02em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        ${options.success
          ? '<polyline points="20 6 9 17 4 12"></polyline>'
          : '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'}
      </svg>
    </div>
    <h1>${headline}</h1>
    <p>${body}</p>
    <div class="actions">
      <button id="close-btn" class="close-btn">Close window</button>
      ${options.success ? '<div class="countdown">This tab will close in <span id="countdown">5</span> seconds</div>' : ''}
    </div>
    <div class="brand">Duya Desktop</div>
  </div>
  ${countdownScript}
</body>
</html>`;
}

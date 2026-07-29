/**
 * Loopback HTTP server for OAuth redirect capture.
 *
 * Plan 312 Phase 1. RFC 8252 §7.3: native apps use loopback redirect
 * (`http://127.0.0.1:<port>/<path>`). We bind only 127.0.0.1, accept a
 * single callback, validate `state`, then close the server.
 *
 * Security:
 * - Bind to `127.0.0.1` only (no 0.0.0.0 / external interface)
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
      res.end(
        '<html><body><h2>Authorization denied</h2>' +
          `<p>${escapeHtml(errorDescription ?? error)}</p>` +
          '<p>You can close this tab and return to Duya.</p></body></html>',
      );
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
    res.end(
      '<html><body><h2>Authorized</h2>' +
        '<p>You can close this tab and return to Duya.</p></body></html>',
    );
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
    server.listen(preferredPort, '127.0.0.1', () => {
      const addr = server?.address() as AddressInfo | null;
      if (!addr || typeof addr.port !== 'number') {
        reject(new LoopbackServerError('failed to bind loopback server'));
        close();
        return;
      }
      const port = addr.port;
      resolve({
        port,
        redirectUri: `http://127.0.0.1:${port}${path}`,
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

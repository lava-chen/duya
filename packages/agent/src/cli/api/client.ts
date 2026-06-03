/**
 * packages/agent/src/cli/api/client.ts
 *
 * CLI API HTTP client.
 *
 * - Reads userData/runtime/cli-api.json to discover port + token.
 * - On 401 from the server, re-reads the runtime file once in case the
 *   desktop app was restarted between our first read and our request
 *   (which would rotate the bearer token).
 * - Built-in 3s per-attempt timeout via AbortController.
 * - Throws CliApiError; never logs the bearer token.
 * - Provides a non-fail-fast `probe()` method for `duya doctor`.
 */

import { CliApiError, APP_NOT_RUNNING_HINT, AUTH_FAILED_HINT } from './errors.js';
import { readCliApiRuntime } from './runtime-config.js';

const REQUEST_TIMEOUT_MS = 3000;

interface RequestOptions {
  timeoutMs?: number;
  /** When set, the request is issued at this base URL instead of the
   *  runtime-discovered one. Reserved for future phases; NOT exposed
   *  via --api/--token in Phase 0. */
  baseUrlOverride?: string;
}

/**
 * Result of a non-fail-fast probe used by `duya doctor`.
 * Distinguishes connection failures from auth failures from server errors.
 */
export interface ProbeResult {
  /** Whether the server responded (with any status). */
  reachable: boolean;
  /** HTTP status code if reachable; 0 if connection failed. */
  statusCode: number;
  /** Error category if not reachable. */
  error?: 'connection_refused' | 'timeout' | 'auth_failed' | 'server_error' | 'malformed_response' | 'runtime_not_found' | 'runtime_malformed';
  /** Human-readable message for user display. Never includes token. */
  message: string;
}

export class CliApiClient {
  private baseUrl: string | null = null;
  private token: string | null = null;

  static async connect(opts: RequestOptions = {}): Promise<CliApiClient> {
    if (opts.baseUrlOverride) {
      // Reserved path — only triggered programmatically. Not exposed in CLI flags.
      return new CliApiClient(opts.baseUrlOverride, '');
    }

    const lookup = await readCliApiRuntime();
    if (lookup.kind === 'not_running') {
      throw new CliApiError('app_not_running', APP_NOT_RUNNING_HINT, APP_NOT_RUNNING_HINT);
    }
    if (lookup.kind === 'malformed') {
      throw new CliApiError(
        'app_not_running',
        APP_NOT_RUNNING_HINT,
        `${APP_NOT_RUNNING_HINT} (runtime file: ${lookup.reason})`,
      );
    }
    return new CliApiClient(`http://127.0.0.1:${lookup.runtime.port}`, lookup.runtime.token);
  }

  constructor(baseUrl = '', token = '') {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = (opts.baseUrlOverride ?? this.baseUrl ?? '') + path;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

    // Two attempts: first with the token we read; on 401, re-read runtime
    // file once (in case the desktop app was restarted) and retry.
    let res = await this.send(url, this.token ?? '', timeoutMs);
    if (res.status === 401) {
      const lookup = await readCliApiRuntime();
      if (lookup.kind === 'ok') {
        this.token = lookup.runtime.token;
        this.baseUrl = `http://127.0.0.1:${lookup.runtime.port}`;
        res = await this.send(this.baseUrl + path, this.token, timeoutMs);
      }
    }

    return this.parse<T>(res);
  }

  /**
   * POST request for write operations. Adds `X-Correlation-Id`
   * header from `opts.correlationId`. On 401, re-reads runtime
   * file once and retries.
   */
  async post<T = unknown>(
    path: string,
    body: unknown,
    opts: RequestOptions & { correlationId?: string } = {},
  ): Promise<T> {
    const url = (opts.baseUrlOverride ?? this.baseUrl ?? '') + path;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.correlationId) headers['X-Correlation-Id'] = opts.correlationId;

    let res = await this.sendWithBody(
      url,
      this.token ?? '',
      timeoutMs,
      JSON.stringify(body),
      headers,
    );
    if (res.status === 401) {
      const lookup = await readCliApiRuntime();
      if (lookup.kind === 'ok') {
        this.token = lookup.runtime.token;
        this.baseUrl = `http://127.0.0.1:${lookup.runtime.port}`;
        res = await this.sendWithBody(
          this.baseUrl + path,
          this.token,
          timeoutMs,
          JSON.stringify(body),
          headers,
        );
      }
    }
    return this.parse<T>(res);
  }

  /**
   * Non-fail-fast probe for `duya doctor`.
   *
   * Unlike `connect()` which throws, this method always returns a
   * structured ProbeResult. It never throws.
   */
  async probe(path: string, timeoutMs?: number): Promise<ProbeResult> {
    try {
      // First check if runtime is available
      const lookup = await readCliApiRuntime();
      if (lookup.kind === 'not_running') {
        return {
          reachable: false,
          statusCode: 0,
          error: 'runtime_not_found',
          message: 'DUYA is not running. Open the DUYA app and retry.',
        };
      }
      if (lookup.kind === 'malformed') {
        return {
          reachable: false,
          statusCode: 0,
          error: 'runtime_malformed',
          message: `Runtime file is invalid: ${lookup.reason}`,
        };
      }

      const url = `http://127.0.0.1:${lookup.runtime.port}${path}`;
      const timeout = timeoutMs ?? REQUEST_TIMEOUT_MS;
      const res = await this.send(url, lookup.runtime.token, timeout);

      if (res.rawError === 'timeout') {
        return {
          reachable: true,
          statusCode: 0,
          error: 'timeout',
          message: 'Request timed out. The DUYA app did not respond in time.',
        };
      }
      if (res.rawError === 'connection_refused') {
        return {
          reachable: false,
          statusCode: 0,
          error: 'connection_refused',
          message: 'Cannot connect to DUYA. Is the app running?',
        };
      }

      if (res.status === 401) {
        return {
          reachable: true,
          statusCode: 401,
          error: 'auth_failed',
          message: 'Authentication failed. The DUYA app may have restarted.',
        };
      }

      if (res.status >= 500) {
        return {
          reachable: true,
          statusCode: res.status,
          error: 'server_error',
          message: `DUYA app returned an error (HTTP ${res.status}).`,
        };
      }

      // Success or client error — doctor handles these
      return {
        reachable: true,
        statusCode: res.status,
        message: res.status === 200
          ? 'DUYA app is reachable.'
          : `DUYA app responded with HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        reachable: false,
        statusCode: 0,
        error: 'server_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async send(
    url: string,
    token: string,
    timeoutMs: number,
  ): Promise<{ status: number; body: string; rawError?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'AbortError') {
        return { status: 0, body: '', rawError: 'timeout' };
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        return { status: 0, body: '', rawError: 'connection_refused' };
      }
      return { status: 0, body: '', rawError: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendWithBody(
    url: string,
    token: string,
    timeoutMs: number,
    bodyText: string,
    extraHeaders: Record<string, string>,
  ): Promise<{ status: number; body: string; rawError?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: bodyText,
        signal: controller.signal,
      });
      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'AbortError') {
        return { status: 0, body: '', rawError: 'timeout' };
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
        return { status: 0, body: '', rawError: 'connection_refused' };
      }
      return { status: 0, body: '', rawError: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: { status: number; body: string; rawError?: string }): Promise<T> {
    if (res.rawError === 'timeout') {
      throw new CliApiError('timeout', 'Request timed out', 'The DUYA app did not respond in time.');
    }
    if (res.rawError === 'connection_refused') {
      throw new CliApiError('connection_refused', APP_NOT_RUNNING_HINT, APP_NOT_RUNNING_HINT);
    }
    if (res.status === 401) {
      throw new CliApiError(
        'auth_failed',
        'Authentication failed',
        AUTH_FAILED_HINT,
        401,
      );
    }
    if (res.status === 404) {
      const serverMsg = extractServerMessage(res.body);
      throw new CliApiError(
        'not_found',
        serverMsg ?? 'Not found',
        serverMsg ?? 'The requested resource was not found.',
        404,
      );
    }
    if (res.status >= 400 && res.status < 500) {
      const serverMsg = extractServerMessage(res.body);
      throw new CliApiError(
        'server_error',
        serverMsg ?? `HTTP ${res.status}`,
        serverMsg ?? `Server responded with ${res.status}.`,
        res.status,
      );
    }
    if (res.status >= 500) {
      throw new CliApiError(
        'server_error',
        'DUYA app returned an error',
        `Server responded with ${res.status}.`,
        res.status,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new CliApiError(
        'server_error',
        `Unexpected HTTP status ${res.status}`,
        `Server responded with ${res.status}.`,
        res.status,
      );
    }

    try {
      return JSON.parse(res.body) as T;
    } catch (err) {
      throw new CliApiError(
        'malformed_response',
        'Response is not valid JSON',
        `Failed to parse server response: ${String(err)}`,
      );
    }
  }
}

/**
 * Extract the user-facing error message from a server JSON body
 * (shape: { error: { message: string } }). Returns null if the body
 * is not a valid error envelope.
 */
function extractServerMessage(body: string): string | null {
  try {
    const obj = JSON.parse(body) as { error?: { message?: string } };
    const msg = obj?.error?.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  } catch {
    // ignore
  }
  return null;
}

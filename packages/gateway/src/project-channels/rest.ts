/**
 * rest.ts — minimal Discord REST client for the project-channel transport.
 *
 * This is deliberately NOT `DiscordAdapter.fetchApi`: that helper throws a
 * message-only `Error('Discord API error: 429')`, which erases the one fact the
 * caller needs — whether the request was definitely not applied (429 with a
 * Retry-After) or may have been applied (timeout, 5xx, dropped socket). Here a
 * call returns a discriminated outcome and the caller classifies it, so
 * `queued` never becomes `sent` by accident.
 *
 * Nothing in this file logs or returns the token. Bodies are never echoed.
 */

import { systemTimers, type DiscordTimers } from './timers.js';

export const DEFAULT_DISCORD_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * - `ok`      — platform acknowledged, body parsed.
 * - `http`    — platform answered with a non-2xx status. `retryAfterMs` is set
 *               only when the platform supplied a Retry-After.
 * - `network` — no readable answer: transport error, abort, or an unparseable
 *               body. `timedOut` separates our own deadline from the rest. A
 *               write that ends here has NO evidence either way.
 */
export type DiscordRestOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'http'; readonly status: number; readonly retryAfterMs?: number }
  | { readonly kind: 'network'; readonly timedOut: boolean };

export interface DiscordRestOptions {
  readonly fetchImpl: typeof fetch;
  readonly apiBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly timers: DiscordTimers;
}

export class DiscordRestClient {
  private readonly options: DiscordRestOptions;

  constructor(options: Partial<DiscordRestOptions> = {}) {
    this.options = {
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_DISCORD_API_BASE,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      timers: options.timers ?? systemTimers,
    };
  }

  get<T>(token: string, path: string): Promise<DiscordRestOutcome<T>> {
    return this.request<T>(token, 'GET', path);
  }

  post<T>(token: string, path: string, body: unknown): Promise<DiscordRestOutcome<T>> {
    return this.request<T>(token, 'POST', path, body);
  }

  private async request<T>(
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<DiscordRestOutcome<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const deadline = this.options.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.requestTimeoutMs);

    try {
      const response = await this.options.fetchImpl(`${this.options.apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const retryAfterMs = await readRetryAfterMs(response);
        return retryAfterMs === undefined
          ? { kind: 'http', status: response.status }
          : { kind: 'http', status: response.status, retryAfterMs };
      }

      try {
        return { kind: 'ok', value: (await response.json()) as T };
      } catch {
        // 2xx with an unreadable body: the platform did act, but nobody can
        // prove what it returned. That is "no evidence", not "not sent".
        return { kind: 'network', timedOut: false };
      }
    } catch {
      return { kind: 'network', timedOut };
    } finally {
      this.options.timers.clearTimeout(deadline);
    }
  }
}

/**
 * Discord sends `retry_after` as float seconds in the body and, on some routes,
 * `Retry-After` as seconds in the header. Prefer the header (it is what the
 * platform documents) and fall back to the body. A 429 without either is still
 * retryable, just without a budget hint.
 */
async function readRetryAfterMs(response: Response): Promise<number | undefined> {
  const header = response.headers?.get?.('retry-after') ?? null;
  const headerSeconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.ceil(headerSeconds * 1000);
  }

  if (response.status !== 429) return undefined;

  try {
    const parsed = (await response.clone().json()) as { retry_after?: unknown };
    const seconds = typeof parsed.retry_after === 'number' ? parsed.retry_after : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  } catch {
    // Body already consumed or not JSON — fall through to the default budget.
  }
  // A 429 is a definite non-delivery; retry pacing without a hint is still
  // bounded by the caller, never unbounded here.
  return 1000;
}

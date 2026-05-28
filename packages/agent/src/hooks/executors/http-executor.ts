/**
 * HTTP Hook Executor
 *
 * Sends HTTP requests to external services.
 * Used for webhook callbacks, monitoring alerts, external system integration.
 *
 * Security: Only HTTPS URLs are allowed.
 */

import type { HookResult, HttpHook } from '../types.js';

interface HookExecutorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_HTTP_TIMEOUT = 30 * 1000;

/**
 * Execute an HTTP hook - sends HTTP request and processes the response
 */
export async function executeHttpHook(
  hook: HttpHook,
  jsonInput: string,
  options: HookExecutorOptions = {},
): Promise<Omit<HookResult, 'hook'>> {
  const timeoutMs = (hook.timeout ? hook.timeout * 1000 : 0) || options.timeoutMs || DEFAULT_HTTP_TIMEOUT;

  if (!hook.url.startsWith('https://')) {
    return {
      outcome: 'non_blocking_error',
      systemMessage: 'HTTP hook only supports HTTPS URLs',
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const signal = options.signal || controller.signal;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(hook.headers || {}),
    };

    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body: jsonInput,
      signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        outcome: 'non_blocking_error',
        systemMessage: `HTTP hook returned status ${response.status}`,
      };
    }

    try {
      const body = await response.json() as Record<string, unknown>;
      const result: Omit<HookResult, 'hook'> = { outcome: 'success' };

      if (body.decision === 'block') {
        result.permissionBehavior = 'deny';
        result.blockingError = {
          blockingError: String(body.reason || 'Blocked by HTTP hook'),
          command: hook.url,
        };
        result.outcome = 'blocking';
      } else if (body.decision === 'approve') {
        result.permissionBehavior = 'allow';
      }

      if (body.systemMessage) {
        result.systemMessage = String(body.systemMessage);
      }

      if (body.hookSpecificOutput) {
        result.additionalContext = JSON.stringify(body.hookSpecificOutput);
      }

      return result;
    } catch {
      return { outcome: 'success' };
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { outcome: 'cancelled' };
    }
    return {
      outcome: 'non_blocking_error',
      systemMessage: `HTTP hook error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default executeHttpHook;
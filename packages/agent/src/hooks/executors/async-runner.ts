/**
 * Async Hook Runner
 *
 * Provides background execution of hooks with async: true response.
 * Supports fire-and-forget (default) and asyncRewake (opt-in re-wake model).
 */

import type { HookCommand, HookInput, HookEvent, HookResult } from '../types.js';

interface HookExecutorOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface AsyncHookCallbacks {
  onComplete?: (result: HookResult) => void;
  onError?: (error: Error) => void;
}

interface PendingAsyncHook {
  hook: HookCommand;
  hookEvent: HookEvent;
  hookInput: HookInput;
  options: HookExecutorOptions;
  asyncTimeout: number;
  callbacks: AsyncHookCallbacks;
  abortController: AbortController;
}

/**
 * Registry of pending async hooks
 */
const pendingAsyncHooks: Map<string, PendingAsyncHook> = new Map();

/**
 * Rewake callback - called when async hook completes with asyncRewake: true
 */
let rewakeCallback: ((result: HookResult) => void) | null = null;

/**
 * Register a rewake callback
 */
export function registerRewakeCallback(callback: (result: HookResult) => void): void {
  rewakeCallback = callback;
}

/**
 * Unregister the rewake callback
 */
export function unregisterRewakeCallback(): void {
  rewakeCallback = null;
}

/**
 * Spawn an async hook execution in the background.
 * Returns immediately without blocking.
 */
export function spawnAsyncHook(
  hookId: string,
  hook: HookCommand,
  hookEvent: HookEvent,
  hookInput: HookInput,
  asyncTimeout: number,
  options: HookExecutorOptions = {},
  callbacks: AsyncHookCallbacks = {},
): void {
  const abortController = new AbortController();

  const pending: PendingAsyncHook = {
    hook,
    hookEvent,
    hookInput,
    options,
    asyncTimeout,
    callbacks,
    abortController,
  };

  pendingAsyncHooks.set(hookId, pending);

  const effectiveTimeout = asyncTimeout || (hook.timeout ? hook.timeout * 1000 : 10 * 60 * 1000);
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, effectiveTimeout);

  runAsyncHook(hookId)
    .then((result) => {
      clearTimeout(timeoutId);
      pendingAsyncHooks.delete(hookId);

      if (callbacks.onComplete) {
        callbacks.onComplete(result);
      }

      if (rewakeCallback) {
        rewakeCallback(result);
      }
    })
    .catch((error) => {
      clearTimeout(timeoutId);
      pendingAsyncHooks.delete(hookId);

      if (callbacks.onError) {
        callbacks.onError(error);
      }
    });
}

/**
 * Run an async hook to completion
 */
async function runAsyncHook(hookId: string): Promise<HookResult> {
  const pending = pendingAsyncHooks.get(hookId);
  if (!pending) {
    return {
      outcome: 'cancelled',
      hook: { type: 'command', command: '' } as HookCommand,
    };
  }

  const { executeHook } = await import('../utils/hooks.js');
  const result = await executeHook(
    pending.hook,
    pending.hookEvent,
    pending.hookInput,
    {
      timeoutMs: pending.asyncTimeout,
      signal: pending.abortController.signal,
    },
  );

  return result;
}

/**
 * Check if an async hook is still running
 */
export function isAsyncHookRunning(hookId: string): boolean {
  return pendingAsyncHooks.has(hookId);
}

/**
 * Cancel a running async hook
 */
export function cancelAsyncHook(hookId: string): boolean {
  const pending = pendingAsyncHooks.get(hookId);
  if (pending) {
    pending.abortController.abort();
    pendingAsyncHooks.delete(hookId);
    return true;
  }
  return false;
}

/**
 * Get count of pending async hooks
 */
export function getPendingAsyncHookCount(): number {
  return pendingAsyncHooks.size;
}

/**
 * Cancel all pending async hooks
 */
export function cancelAllAsyncHooks(): void {
  for (const [hookId, pending] of pendingAsyncHooks) {
    pending.abortController.abort();
  }
  pendingAsyncHooks.clear();
}

export default {
  spawnAsyncHook,
  isAsyncHookRunning,
  cancelAsyncHook,
  getPendingAsyncHookCount,
  cancelAllAsyncHooks,
  registerRewakeCallback,
  unregisterRewakeCallback,
};
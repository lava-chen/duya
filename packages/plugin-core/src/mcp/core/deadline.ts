// packages/plugin-core/src/mcp/core/deadline.ts
// Plan 580 D5 — single-deadline clock with per-request abort bridging.
//
// Contract (plan 580 §D5): every tool call / discovery pass produces ONE
// deadline; the MCP SDK receives `{ timeout: remainingMs, signal }` and
// handles expiry internally (including per-request cancellation to the
// server). We NEVER close a shared transport because a single request
// aborted — a transport/session serves multiple concurrent requests.

import { McpError } from './error-taxonomy.js';

export interface DeadlineClock {
  /** Absolute epoch-ms deadline. */
  readonly deadlineAt: number;
  /** Milliseconds remaining (never negative). */
  remainingMs(now?: number): number;
  /** True when the deadline has passed. */
  isExpired(now?: number): boolean;
  /**
   * The shared AbortSignal for this deadline. The signal fires when
   * `abort()` is called explicitly (e.g. deadline enforcement by the
   * caller) — the SDK also applies its own `timeout` cut-off, so the
   * signal is an additional control plane, not the only one.
   */
  readonly signal: AbortSignal;
  /** Fire the abort signal (idempotent). */
  abort(reason?: unknown): void;
  /** True once `abort()` has been called. */
  readonly aborted: boolean;
  /** Throw `MCP_TIMEOUT` when the deadline has passed. */
  throwIfExpired(label?: string): void;
}

/**
 * Create a deadline clock that expires `timeoutMs` from `now`
 * (defaults to `Date.now()`).
 */
export function createDeadlineClock(timeoutMs: number, now?: number): DeadlineClock {
  const start = now ?? Date.now();
  return deadlineClockFrom(start + Math.max(0, Math.round(timeoutMs)), start);
}

/**
 * Create a deadline clock from an absolute epoch-ms deadline. Used by
 * chain B, where the worker computes `deadlineAt` and the main process
 * re-derives remaining time on the other side of IPC.
 */
export function deadlineClockFrom(deadlineAt: number, now?: number): DeadlineClock {
  const controller = new AbortController();
  const clock: DeadlineClock = {
    deadlineAt,
    remainingMs(at?: number): number {
      return Math.max(0, deadlineAt - (at ?? Date.now()));
    },
    isExpired(at?: number): boolean {
      return (at ?? Date.now()) >= deadlineAt;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    abort(reason?: unknown): void {
      if (!controller.signal.aborted) controller.abort(reason ?? new McpError('MCP_TIMEOUT', 'deadline exceeded'));
    },
    get aborted(): boolean {
      return controller.signal.aborted;
    },
    throwIfExpired(label?: string): void {
      if (clock.isExpired()) {
        throw new McpError('MCP_TIMEOUT', `deadline exceeded${label ? `: ${label}` : ''}`);
      }
    },
  };
  return clock;
}

/**
 * Derive a `DeadlineClock` from a `deadlineAt` stamp received over IPC.
 * Returns `undefined` when the stamp is missing/malformed so callers
 * can fall back to their local default timeout (backward compatibility
 * with older workers that do not send `deadlineAt`).
 */
export function deadlineClockFromIpc(value: unknown): DeadlineClock | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return deadlineClockFrom(value);
}

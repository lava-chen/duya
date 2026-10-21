/**
 * Memory wakeup helper (Plan 305 Phase B).
 *
 * Fire-and-forget nudge sent from the agent subprocess to the Electron
 * main process right after `ready`. The main-process router intercepts
 * the `memory:wakeup` worker event and invokes
 * `getMemoryWorkerHandle()?.forceSweep()` so a freshly-initialized
 * session triggers Stage 1 extraction without waiting for the worker's
 * 60s interval.
 *
 * Shadow mode: gated by `DUYA_MEMORY_ENABLED` (legacy
 * `DUYA_MEMORY_V2_ENABLED` still honored). Failures are swallowed
 * (best-effort) so the agent's startup path never breaks on a memory
 * pipeline error.
 */

export interface MemoryWakeupEvent {
  type: 'memory:wakeup';
  sessionId?: string;
}

export type SendWakeupFn = (event: MemoryWakeupEvent) => void;

export interface SendMemoryWakeupOptions {
  /** Session identifier, if known. */
  sessionId?: string;
  /**
   * Called when `send` throws. The caller supplies it because logging is a
   * host concern: this module used to reach into the agent's logger directly,
   * which was the only edge from this package into agent infrastructure.
   * Omitted means the failure is swallowed silently, which is still the
   * contract -- a throw here must never break the agent's startup path.
   */
  onError?: (error: unknown) => void;
  /**
   * Explicit enable override. When omitted, the helper reads
   * `DUYA_MEMORY_ENABLED` from the environment.
   */
  enabled?: boolean;
}

/**
 * Send the `memory:wakeup` event via the provided `send` callback.
 *
 * The helper is extracted from `agent-process-entry.ts` so the gating
 * and error-suppression logic is unit-testable without spinning up a
 * real worker process.
 *
 * Contract:
 *   - When disabled (env unset and `enabled` not `true`): no-op, returns 0.
 *   - When enabled and `send` succeeds: returns 1.
 *   - When enabled and `send` throws: reports via `opts.onError` and returns 0.
 *     The throw NEVER propagates to the caller (shadow-mode tolerance).
 */
export function sendMemoryWakeup(
  send: SendWakeupFn,
  opts: SendMemoryWakeupOptions = {},
): number {
  const enabled = opts.enabled ?? isMemoryEnabled();
  if (!enabled) {
    return 0;
  }
  try {
    send({
      type: 'memory:wakeup',
      sessionId: opts.sessionId,
    });
    return 1;
  } catch (err) {
    // Shadow mode: best-effort. Never break the agent's startup path.
    try {
      opts.onError?.(err);
    } catch {
      // The error handler itself failed — swallow entirely.
    }
    return 0;
  }
}

/**
 * Read the `DUYA_MEMORY_ENABLED` env var (legacy
 * `DUYA_MEMORY_V2_ENABLED` still honored as an alias). Exported for
 * test overrides via `vi.mock`.
 *
 * Dev default-on: when `DUYA_DEV=1` is set (agent subprocess spawned
 * from a dev Electron), the wakeup is sent automatically to accumulate
 * shadow data for the 4-week validation window required by Plan 305.
 * Explicit opt-out via `DUYA_MEMORY_ENABLED=0` is still honored.
 */
export function isMemoryEnabled(): boolean {
  const v = process.env.DUYA_MEMORY_ENABLED ?? process.env.DUYA_MEMORY_V2_ENABLED;
  if (v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  return process.env.DUYA_DEV === '1';
}

/**
 * DeadLoopTracker — Plan 550 step 2e (TurnPreparer).
 *
 * Tracks consecutive identical tool-use calls (matching tool name AND
 * JSON-serialised input) within a single `streamChat` run. The streak
 * is consumed by two engines:
 *
 *   - The PostToolUse dead-loop nudge hook (soft "change approach"
 *     reminder at `nudgeAt` calls, stronger "stop repeating" reminder
 *     at `hardNudgeAt`).
 *   - The engine invariant at the top of every turn: hard-stop when
 *     the streak hits `hardStopAt`, regardless of hook state.
 *
 * Why extracted:
 *   The state previously lived as three loose `let` bindings inside
 *   `DuyaAgent.streamChat` (lastSignature / consecutiveToolCalls /
 *   consecutiveToolName), updated at four sites and read at three.
 *   Pulling it behind a small class:
 *     1. Makes the streak invariants (signature separator, JSON
 *        serialisation, threshold defaults) testable in isolation.
 *     2. Lets `TurnPreparer` own the per-run allocation in one place
 *        instead of fragmenting it across streamChat's prologue.
 *     3. Provides a clean `reset()` for stream-replay, replacing the
 *        duplicated three-line reset that lived inline next to the
 *        retry loop.
 *
 * Streak separator: `\u0001` is a safe field separator that cannot
 * appear in a tool name or in JSON input — same convention as the
 * pre-extraction inline code so the resulting `signature` strings
 * are bit-identical.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import type { ConsecutiveToolCallStats } from '../hooks/loop.js';

export interface AntiDeadLoopConfig {
  enabled?: boolean;
  nudgeAt?: number;
  hardNudgeAt?: number;
  hardStopAt?: number;
}

export interface DeadLoopTrackerOptions {
  enabled: boolean;
  nudgeAt: number;
  hardNudgeAt: number;
  hardStopAt: number;
}

export const DEFAULTS: Required<AntiDeadLoopConfig> = Object.freeze({
  enabled: true,
  nudgeAt: 8,
  hardNudgeAt: 12,
  hardStopAt: 16,
});

/**
 * Normalise the optional config object on `ChatOptions.antiDeadLoop`
 * into a fully-populated tracker configuration. Centralising the
 * defaulting keeps the tracker branch-free at call sites.
 */
export function resolveDeadLoopConfig(
  config: AntiDeadLoopConfig | undefined,
): DeadLoopTrackerOptions {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  return {
    enabled: merged.enabled,
    nudgeAt: merged.nudgeAt,
    hardNudgeAt: merged.hardNudgeAt,
    hardStopAt: merged.hardStopAt,
  };
}

/**
 * Compose the signature string used to compare two tool calls for
 * equality. Names and JSON inputs are joined by U+0001; the input
 * serialisation falls back to `'{}'` for undefined / null so the
 * legacy `JSON.stringify(block.input ?? {})` behaviour is preserved.
 */
export function toolCallSignature(name: string, input: unknown): string {
  return `${name}\u0001${JSON.stringify(input ?? {})}`;
}

/**
 * Engine invariant tracker for the consecutive-identical-call streak.
 *
 * Lifecycle:
 *   - Construct once per `streamChat` call with the resolved config
 *     (typically by `TurnPreparer`).
 *   - Call `record(name, input)` once per `tool_use` event the agent
 *     dispatches.
 *   - Read via `stats()` for the PostToolUse nudge hook.
 *   - Read via `shouldHardStop()` at the top of every turn.
 *   - Call `reset()` on stream replay / discard.
 *
 * Thread safety: not concurrent. The agent loop is single-threaded;
 * the tracker lives entirely inside `streamChat`'s generator body.
 */
export class DeadLoopTracker {
  private readonly options: DeadLoopTrackerOptions;
  private lastSignature: string | null = null;
  private count = 0;
  private currentName: string | null = null;

  constructor(options: DeadLoopTrackerOptions) {
    this.options = options;
  }

  /**
   * Record a tool call. Updates the streak counter. The new stats are
   * always available via `stats()`; `record` returns `void` because
   * the read site (PostToolUse dispatch) runs in a different scope
   * and uses the explicit `stats()` accessor.
   */
  record(name: string, input: unknown): void {
    const signature = toolCallSignature(name, input);
    if (signature === this.lastSignature) {
      this.count += 1;
    } else {
      this.lastSignature = signature;
      this.count = 1;
    }
    this.currentName = name;
  }

  /**
   * Snapshot consumed by the PostToolUse dead-loop nudge hook. Returns
   * `undefined` when no tool call has been recorded yet so the hook can
   * short-circuit before its threshold checks.
   */
  stats(): ConsecutiveToolCallStats | undefined {
    if (this.count === 0 || this.currentName === null) return undefined;
    return {
      count: this.count,
      toolName: this.currentName,
      nudgeAt: this.options.nudgeAt,
      hardNudgeAt: this.options.hardNudgeAt,
    };
  }

  /**
   * Engine invariant: whether to abort the run because the model is
   * stuck in a tight loop. Distinct from the soft/hard nudge hooks —
   * this is a hard cap that fires regardless of hook state.
   */
  shouldHardStop(): boolean {
    return this.options.enabled && this.count >= this.options.hardStopAt;
  }

  /**
   * Static configuration of the tracker — used to wire the soft/hard
   * nudge hooks (`createBuiltinLoopHooks({ antiDeadLoop: ... })`) so
   * both the engine invariant and the hook text speak the same
   * thresholds. Read-only; the runner mutates the streak, never the
   * config.
   */
  get config(): Readonly<DeadLoopTrackerOptions> {
    return this.options;
  }

  /**
   * Clear the streak. Used after a stream replay (where the previous
   * attempt's identical calls would otherwise inflate the next
   * attempt's counter) and on `discard()` / abort.
   */
  reset(): void {
    this.lastSignature = null;
    this.count = 0;
    this.currentName = null;
  }

  /** Test / debug accessor — never mutate. */
  get debugState(): { count: number; name: string | null; enabled: boolean } {
    return {
      count: this.count,
      name: this.currentName,
      enabled: this.options.enabled,
    };
  }
}
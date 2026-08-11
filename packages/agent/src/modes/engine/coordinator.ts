/**
 * ModeCoordinator — runtime orchestrator for mode trackers (plan 413).
 *
 * Plan 413a ships the skeleton: constructor and method signatures are
 * final, but the bodies are no-ops / pass-throughs until plan 413d wires
 * them into the `DuyaAgent.streamChat` turn loop. Keeping them
 * non-throwing means nothing crashes if a stub is invoked before 413d
 * lands, and the skeleton can be compiled and unit-tested independently.
 *
 * Responsibilities (implemented in 413d):
 *  - `injectTurnReminders` : per-turn `<system-reminder>` injection
 *  - `onRoundEnd`          : round-end transitions + persist
 *  - `refreshTurn`         : mid-turn buffered-reminder flush
 *  - `filterTools`         : state-based runtime tool gating
 *  - `resolveTurnMode`     : synthetic/user turn arbitration
 */

import type { ModeTrackerEngine } from './engine.js';

export class ModeCoordinator {
  constructor(
    private readonly engine: ModeTrackerEngine,
    private readonly sessionId: string,
  ) {}

  /**
   * Per-turn LLM-call preamble: render and inject reminders for every
   * active tracker (plan 413d). Skeleton in 413a — no-op.
   */
  injectTurnReminders(messages: unknown[], seqIndex: number): void {
    // Implemented in plan 413d.
    void messages;
    void seqIndex;
  }

  /**
   * Round end: state transitions (e.g. plan's `exit_pending -> inactive`)
   * + snapshot persistence (plan 413d). Skeleton in 413a — no-op.
   */
  onRoundEnd(): void {
    // Implemented in plan 413d.
  }

  /**
   * Turn-loop top: flush buffered mid-turn activation reminders at a safe
   * point (plan 413d). Skeleton in 413a — no-op.
   */
  refreshTurn(): void {
    // Implemented in plan 413d.
  }

  /**
   * State-based runtime tool gating: narrow the tool set when any active
   * tracker has `canGateTools() === true` (plan 413d). Skeleton in 413a —
   * pass-through until then.
   */
  filterTools(tools: unknown[]): unknown[] {
    return tools;
  }

  /** The engine backing this coordinator (exposed for tests / 413d wiring). */
  getEngine(): ModeTrackerEngine {
    return this.engine;
  }
}

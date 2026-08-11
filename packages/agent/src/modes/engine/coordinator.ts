/**
 * ModeCoordinator — runtime orchestrator over all mode trackers (plan 413).
 *
 * Skeleton for 413a: the method bodies are no-ops / minimal returns so the
 * module compiles and its unit tests pass standalone. The real wiring —
 * per-turn reminder injection, round-end transitions, mid-turn buffering, and
 * runtime tool gating — is filled in by 413d once the `DuyaAgent` loop
 * checkpoints are in scope.
 */

import type { ModeTrackerEngine } from './engine.js';

export class ModeCoordinator {
  constructor(
    private readonly engine: ModeTrackerEngine,
    private readonly sessionId: string,
  ) {}

  /**
   * Before each LLM call: render and inject `<system-reminder>`s per tracker
   * state (full / sparse alternation). Implemented in 413d.
   */
  injectTurnReminders(messages: unknown[], seqIndex: number): void {
    // 413d: buffer reminders against tracker states; append as synthetic user messages.
    void messages;
    void seqIndex;
  }

  /** Round end: round-completion judgment + state transitions + persist (413d). */
  onRoundEnd(): void {
    // 413d: persist snapshots when a transition changed tracker state.
  }

  /** Turn-loop top: flush mid-turn buffered reminders at a safe point (413d). */
  refreshTurn(): void {
    // 413d: flush reminders buffered during an in-flight turn.
  }

  /**
   * Filter the tool set by current tracker gating states (413d). The skeleton
   * returns the input unchanged.
   */
  filterTools(tools: unknown[]): unknown[] {
    // 413d: shrink the set when a tracker's canGateTools() is active.
    return tools;
  }
}

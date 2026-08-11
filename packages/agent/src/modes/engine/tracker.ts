/**
 * ModeTracker — pure state-machine contract for stateful modes (plan 413).
 *
 * A ModeTracker is the single deterministic source of truth for one
 * mode's lifecycle state. It is a pure state machine: `transition` only
 * mutates internal state, and `snapshot`/`restore` provide crash-recovery
 * persistence with no async I/O and no DB/IPC access. Persistence plumbing
 * lives in `persistence.ts` (pure serialization helpers) and plan 413c
 * (core-db `mode_state_snapshots` table + IPC).
 *
 * The generic triple keeps the contract type-safe per mode:
 *  - `State`   : the mode's state enum (e.g. `'inactive' | 'pending' | ...`)
 *  - `Event`   : the events that drive transitions
 *  - `Snapshot`: the persisted snapshot shape for this mode
 *
 * Implementations are expected to stay side-effect-free so every mode
 * state machine can be exhaustively unit-tested over its migration matrix.
 */

/** ModeStateSnapshot — persisted snapshot type (plan 413a).
 *
 * Mirrors the columns of the core-db `mode_state_snapshots` table
 * (plan 413c): one row per (sessionId, mode). `data` carries the
 * full mode-specific payload; `status` is a queryable/displayable
 * state string kept in sync by the persistence layer.
 */
export interface ModeStateSnapshot {
  /** tracker.id, e.g. `'plan-task'`. */
  mode: string;
  sessionId: string;
  /** Queryable/displayable status (e.g. `'active'`, `'exit_pending'`). */
  status: string;
  /** Full snapshot payload for the mode (JSON-safe; goal etc. serialize complex state here). */
  data: unknown;
  /** Epoch millis of the last transition that produced this snapshot. */
  updatedAt: number;
}

/** Pure state machine contract for a stateful mode (plan 413).
 *
 * Implementations must be deterministic and free of async I/O. See
 * `engine/plan-tracker.ts` (plan 413b) for the canonical example.
 */
export interface ModeTracker<State extends string, Event, Snapshot> {
  readonly id: string;

  /** Current state. */
  state(): State;

  /**
   * Idempotent transition. Returns whether a transition actually
   * happened (false for illegal/no-op events) so callers can decide
   * whether to persist — mirrors grok's `enter_pending() -> bool`.
   * Must not throw on illegal events.
   */
  transition(event: Event): boolean;

  /** Whether the current state activates runtime tool gating (plan 413d). */
  canGateTools(): boolean;

  /** Whether the current state needs a per-turn reminder (plan 413d). */
  shouldInjectReminder(): boolean;

  /** Full snapshot payload for persistence. */
  snapshot(): Snapshot;

  /** Restore from a snapshot (crash recovery; called by plan 413c/413d).
   *
   * Invalid input should surface as a thrown error so the persistence
   * layer (`applySnapshot`) can report failure; it must never leave the
   * tracker in an inconsistent state.
   */
  restore(raw: Snapshot): void;
}

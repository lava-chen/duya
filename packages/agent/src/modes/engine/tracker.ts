/**
 * ModeTracker — pure state machine contract for stateful modes (plan 413).
 *
 * Plan 224's declarative {@link ModeModifier} is a static per-mode filter:
 * tools / prompt / hooks are fixed at registration time. This layer adds an
 * optional *runtime* state machine on top of it. A {@link ModeTracker} is the
 * single deterministic source of truth for one stateful mode's lifecycle
 * (e.g. plan-task's Inactive/Pending/Active/ExitPending), kept free of async
 * I/O so it can be unit-tested and crash-recovered from a snapshot.
 *
 * The interface is generic over State / Event / Snapshot so concrete modes
 * (plan / goal / automation) keep full type safety. {@link ModeTrackerEngine}
 * holds them as the existential approximation `ModeTracker<string, string, unknown>`.
 */

/**
 * Persisted snapshot wrapper — column-shaped for the core-db
 * `mode_state_snapshots` table (plan 413c).
 */
export interface ModeStateSnapshot {
  /** Tracker id, e.g. `'plan-task'`. Maps to the table's `mode` key. */
  mode: string;
  /** Owning session id. */
  sessionId: string;
  /** Queryable / displayable state (mirrors the table's `status` column). */
  status: string;
  /**
   * Full snapshot payload. Plan stores its state directly; a complex state
   * machine (goal's 8-state tracker) stores its rich object here.
   */
  data: unknown;
  /** Epoch ms when the snapshot was produced. */
  updatedAt: number;
}

/**
 * Minimal contract for a stateful mode: a pure state machine, no I/O.
 *
 * `transition` returns whether a real transition happened (vs. an invalid /
 * idempotent no-op) so the coordinator knows whether the state changed and a
 * persist is warranted — mirroring grok's `enter_pending()` `bool` return.
 */
export interface ModeTracker<State extends string, Event, Snapshot> {
  /** Unique id, e.g. `'plan-task'` | `'goal'`. */
  readonly id: string;
  /** Current state. */
  state(): State;
  /**
   * Idempotent transition. Unrecognized / illegal events are a no-op that
   * returns `false`; a real transition returns `true`.
   */
  transition(event: Event): boolean;
  /** Whether the current state activates runtime tool gating (plan 413d). */
  canGateTools(): boolean;
  /** Whether the current state needs a per-turn reminder injection (plan 413d). */
  shouldInjectReminder(): boolean;
  /** Full snapshot for the coordinator to persist. */
  snapshot(): Snapshot;
  /**
   * Restore from a snapshot (crash recovery; wired in 413c). Implementations
   * must validate the payload and NOT throw on malformed input.
   */
  restore(raw: Snapshot): void;
}

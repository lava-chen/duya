/**
 * TurnEventDispatcher — Plan 550 step 2e infrastructure.
 *
 * Centralised sequence-number tracking for SSE events emitted from
 * `DuyaAgent.streamChat`. Each event the loop produces
 * (`turn_start` / `text` / `tool_use` / `tool_result` / `done` /
 * `tool_intent` / `mode_changed` / `hook_event`) gets a monotonically
 * increasing `seq_index` so the client can reorder late events and
 * detect gaps.
 *
 * This module is the foundation for the multi-commit 2e
 * TurnEventDispatcher extraction. The 13 `yield { type: ... }`
 * sites in `streamChat` (lines 1081, 1813, 1851-1852, 2266, 2311,
 * 2371, 2644, 2725, 3702, 3714) keep emitting inline objects today;
 * subsequent commits (2e-2 / 2e-3) migrate each site to call
 * `dispatcher.dispatchXxx(...)` so the dispatcher becomes the single
 * source of truth for event sequencing.
 *
 * Why a class instead of free functions: the dispatcher's state
 * (`seqIndex`, `turnId`) is per-streamChat-call, and the lifecycle
 * (construct → dispatch sequence → read final seq → dispose) maps
 * cleanly to instance methods. Tests can build an instance with a
 * captured event log and assert ordering without running an
 * `AsyncGenerator`.
 */

/** SSE event shape used by `DuyaAgent.streamChat` consumers. */
export interface DispatchableEvent {
  type: string
  data?: unknown
  reason?: string
  [extra: string]: unknown
}

/** Per-event log entry the dispatcher records when `recordLog: true`. */
export interface DispatchedEntry<E extends DispatchableEvent = DispatchableEvent> {
  /** Monotonic seq_index assigned at dispatch time. */
  seqIndex: number
  /** Optional turn id mirror; set when `attachTurnId(turnId)` was called. */
  turnId: string | null
  /** The event payload (post-decoration). */
  event: E
}

/**
 * Construct a per-streamChat dispatcher. `recordLog` defaults to
 * `false` because the production path yields events directly to the
 * AsyncGenerator consumer — keeping a parallel log array would double
 * the allocation pressure per turn. Tests set `recordLog: true` so
 * they can assert ordering and payloads after the stream completes.
 */
export interface TurnEventDispatcherOptions {
  /** Capture every dispatched event for later inspection. Default: false. */
  recordLog?: boolean
  /** Optional `turnId` mirror stamped on each entry (no payload change). */
  initialTurnId?: string | null
}

export class TurnEventDispatcher {
  private seqIndex = 0
  private turnId: string | null
  private readonly recordLog: boolean
  private readonly log: DispatchedEntry[] = []

  constructor(options: TurnEventDispatcherOptions = {}) {
    this.recordLog = options.recordLog === true
    this.turnId = options.initialTurnId ?? null
  }

  /** Attach / refresh the per-turn id mirror. Called once per turn. */
  attachTurnId(turnId: string | null): void {
    this.turnId = turnId
  }

  /**
   * Stamp `seq_index` onto the event and return it for `yield`. The
   * event object is **not** mutated in place — the dispatcher returns
   * a fresh object so consumers can rely on the input shape being
   * preserved for tests / re-dispatch.
   */
  dispatch<E extends DispatchableEvent>(event: E): E & { seq_index: number } {
    const seqIndex = this.nextSeqIndex()
    const decorated = { ...event, seq_index: seqIndex }
    if (this.recordLog) {
      this.log.push({ seqIndex, turnId: this.turnId, event: decorated })
    }
    return decorated
  }

  /** Read the next seq_index without dispatching (used by close events). */
  peekNextSeqIndex(): number {
    return this.seqIndex
  }

  /**
   * Inspect the captured log. Returns `null` when `recordLog` was
   * not enabled at construction time. Tests use this to assert
   * ordering and event shape after a stream completes.
   */
  getLog(): ReadonlyArray<DispatchedEntry> | null {
    return this.recordLog ? this.log.slice() : null
  }

  /** Final seq_index that was assigned. Useful for `done` event payload. */
  lastAssignedSeqIndex(): number {
    return this.seqIndex - 1
  }

  private nextSeqIndex(): number {
    const next = this.seqIndex
    this.seqIndex += 1
    return next
  }
}
/**
 * Delta coalescing, sitting in front of the seq minting point.
 *
 * ## Where this sits, and why it is here and not downstream
 *
 * Contract section F: `runtime铸造 (runId,seq) 单调全事件顺序` - the runtime mints
 * the single monotonic per-run order - and `durable存储是稀疏子序列，允许seq空洞`.
 * Read the two halves together and the placement is not a style preference:
 * **gaps are allowed in the DURABLE store, and nowhere else.** The live stream is
 * dense by contract.
 *
 * So coalescing has exactly two candidate positions, and the downstream one is
 * the one that breaks the contract:
 *
 *  - **After minting** (wrapping the `EventPublisher`, so envelopes arrive with
 *    a `seq` already on them). Merging there means either renaming a `seq` that
 *    has already been stamped - forbidden outright, and a lie about a number the
 *    ledger already handed out - or keeping the burned numbers, which turns every
 *    merge into a hole in the LIVE stream. A consumer that sees seq 5 then 118
 *    concludes it lost 112 events, and its reconnect path (T3.3) will faithfully
 *    try to replay a range that never existed. Coalescing would convert a
 *    measured saving into a permanent, unexplained gap in the one stream that is
 *    required to have none.
 *  - **Before minting** (this module). A merged delta never receives a `seq` at
 *    all. The frame that is published carries one `seq` and owns it; the ledger
 *    counts one event; the live stream stays dense. There is no reassignment
 *    because there was never an assignment to reassign, which is the only form
 *    of "must never change the id of an already-persisted event" that is
 *    trivially true.
 *
 * This is why `RunEventEmitter` is untouched. T3.2 made it the single mint
 * authority, and a batcher INSIDE it would have to either mint more than one
 * event per `emit` (a new return shape) or mint zero events and report a
 * success carrying no envelope (the kind of lie that gets unnoticed). Instead
 * the batcher is a producer-side filter and the emitter stays the only thing
 * that ever calls `session.observe`. The two compose in one call -
 * {@link batchedPublisher} - and the emitter's own contract is unchanged.
 *
 * ## What may merge, and what may not
 *
 * The key is `runId + messageId + blockIndex + eventType` (plus `toolCallId` for
 * the one delta family that has no message at all). Every clause of that key
 * answers one of contract F's prohibitions:
 *
 *  - `eventType` in the key is what keeps **text and thinking separate**. They
 *    share a payload shape - `{ messageId, index, delta }` - so a key without the
 *    type would happily concatenate a model's reasoning into its answer. That is
 *    the single most damaging merge this module could perform, and it is one
 *    forgotten field away.
 *  - `blockIndex` in the key is what keeps merges **inside one content block**.
 *    A new block is a different key, so the last delta of block 0 can never be
 *    welded onto the first delta of block 1 - which would produce a frame
 *    claiming to be block 0 while carrying block 1's text.
 *  - `messageId` keeps merges inside one message; a new message is a new key.
 *  - `runId` is stated for completeness and is constant for a batcher. It is in
 *    the key because a batcher that a host could reuse across runs would then
 *    be a cross-run merge, and the key should say so structurally rather than
 *    in a comment.
 *
 * ## The barrier rule, and the ordering it must not become
 *
 * A flush is forced by three things: the time window, the byte threshold, and a
 * **causal barrier** - any non-coalescable event, which in practice means every
 * durable event plus both terminals.
 *
 * The direction of a barrier flush is the whole point. On a barrier the pending
 * deltas are emitted FIRST and the barrier event second:
 *
 *     offer(tool.call_started) -> emit [delta@1, delta@2, tool.call_started@3]
 *
 * Never the other way round. It is tempting to treat a durable event as more
 * important and let it overtake the deltas that causally precede it, and that
 * inversion produces a stream where the tool call announces itself before the
 * text that led to it exists anywhere - a consumer that replays the durable
 * subset alone gets a tool call with no preceding assistant turn, and the
 * "durable first" rule is a reordering, not a priority. Contract F says
 * `先flush因果上更早delta，再发tool/terminal；不能为了"durable优先"改变顺序`.
 *
 * ## Merging is LOSSLESS, which is why no gap is owed
 *
 * All three coalescable payloads carry a plain `delta: string`, so merging is
 * string concatenation and a consumer sees identical text. Nothing is dropped
 * here - this module cannot drop an event, and that is deliberate: dropping is
 * the byte-bounded queue's job (`backpressure.ts`), where the loss can be
 * reported and bounded, and doing it here would hide a loss behind a "merge".
 * What a merge DOES owe the observer is the count, and that is
 * {@link CoalescingReceipt}.
 */

import type { EventType, RunEvent, RunId } from '@duya/agent-protocol';
import { EVENT_REGISTRY } from '@duya/agent-protocol';

/**
 * The delta families that may merge.
 *
 * Read from the registry's own durability column rather than restated, because
 * the rule is not "these three types are mergeable" - it is "anything the
 * registry calls ephemeral AND whose payload concatenates". A hand-written list
 * would let a fourth ephemeral event be added and silently bypass coalescing,
 * which is the `registry.ts` header's exact failure.
 */
export const COALESCABLE_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(
  EVENT_REGISTRY.ephemeral.filter(
    (type) => type === 'assistant.text_delta' || type === 'assistant.thinking_delta' || type === 'tool.arguments_delta',
  ),
);

/** True when this event may be merged with its neighbours. */
export function isCoalescable(type: EventType): boolean {
  return COALESCABLE_EVENT_TYPES.has(type);
}

/**
 * Which stream entity a delta belongs to.
 *
 * A closed union rather than three loose optional strings, because the two
 * families key differently and a single "scope string" field would let a tool
 * delta and an assistant delta collide whenever their ids happened to match.
 */
export type CoalesceScope =
  | { readonly kind: 'message'; readonly messageId: string; readonly blockIndex: number }
  | { readonly kind: 'tool'; readonly toolCallId: string };

/**
 * The merge key. One frame's identity.
 *
 * `blockId` in the plan is `index` in this protocol's payload - an assistant
 * block is `{ messageId, index }` and there is no separate block id to read. The
 * name here says `blockIndex` rather than reusing the plan's word so that nobody
 * goes looking for a field the payload does not carry.
 */
export interface CoalesceKey {
  readonly runId: RunId;
  readonly eventType: EventType;
  readonly scope: CoalesceScope;
}

/**
 * The separator between key components.
 *
 * A printable character rather than a control character, so a key is readable in
 * a log line and cannot be mangled on its way to one.
 */
const KEY_SEPARATOR = ':';

/**
 * The key as a string, for a `Map`.
 *
 * **The separator is REFUSED inside any component, and that check is
 * load-bearing rather than defensive.** The obvious version - join the parts and
 * let the boundaries fall where they may - collides:
 *
 *     messageId "a",  blockIndex 12   ->  ma12
 *     messageId "a1", blockIndex 2    ->  ma12
 *
 * Two different content blocks, one key, and their deltas weld together: text
 * from block 1 of message "a1" would be appended to block 12 of message "a". A
 * `messageId` containing the separator fails the same way, more obviously.
 *
 * So the separator is rejected on the way IN, which is the decision T3.3 made
 * for the replay cursor's separator and for the same reason. It throws rather
 * than returning `null`: a key with an unnameable component cannot be skipped,
 * because the caller would carry on coalescing nothing and the block would
 * stream uncoalesced for the rest of the run without anything reporting it.
 *
 * (The earlier spelling here was NUL-separated. PowerShell mangling during
 * development left real NUL bytes in the literal, which compiled and passed
 * every test - so the separator is printable now and a scan for NUL and U+FFFD
 * runs over these files.)
 */
export function coalesceKeyId(key: CoalesceKey): string {
  const id = key.scope.kind === 'message' ? key.scope.messageId : key.scope.toolCallId;
  assertNoSeparator(id);
  const scope =
    key.scope.kind === 'message'
      ? `m${KEY_SEPARATOR}${key.scope.messageId}${KEY_SEPARATOR}${key.scope.blockIndex}`
      : `t${KEY_SEPARATOR}${key.scope.toolCallId}`;
  return `${key.runId}${KEY_SEPARATOR}${key.eventType}${KEY_SEPARATOR}${scope}`;
}

function assertNoSeparator(value: string): void {
  if (value.includes(KEY_SEPARATOR)) {
    throw new Error(
      `a merge key cannot be built: "${value}" contains the key separator "${KEY_SEPARATOR}"`,
    );
  }
}

/**
 * Derive the key for a coalescable event, or `null` when it is not one.
 *
 * `null` for a non-coalescable type rather than a throw: the caller needs to
 * distinguish "not mergeable" from "mergeable but malformed", and only the
 * emitter can decide the second. A missing `delta` on a coalescable type is left
 * for the field manifest to refuse, unchanged and in its own words.
 */
export function coalesceKeyOf(runId: RunId, event: RunEvent): CoalesceKey | null {
  if (!isCoalescable(event.type)) return null;
  switch (event.type) {
    case 'assistant.text_delta':
    case 'assistant.thinking_delta':
      return {
        runId,
        eventType: event.type,
        scope: { kind: 'message', messageId: event.messageId, blockIndex: event.index },
      };
    case 'tool.arguments_delta':
      return { runId, eventType: event.type, scope: { kind: 'tool', toolCallId: event.toolCallId } };
    default:
      // Unreachable: `COALESCABLE_EVENT_TYPES` names exactly the three arms
      // above, and this build knows every `EventType`. Returned rather than
      // asserted so a future fourth coalescable type degrades to "not merged"
      // (correct, just less efficient) instead of a crash in the emit path.
      return null;
  }
}

/** The two thresholds. Both are required; neither is the real bound alone. */
export interface BatchThresholds {
  /**
   * The time window. `0` disables it, leaving the byte threshold to decide.
   *
   * Time alone is the wrong bound for a text stream (a model that stalls
   * mid-sentence leaves one frame per window no matter how small it is), and
   * bytes alone is the wrong bound for a sparse stream (a tool call emitting one
   * delta per second would never coalesce and never know to). So both, and each
   * flushes on whichever arrives first.
   */
  readonly windowMs: number;
  /**
   * The byte threshold for one key's accumulated frame.
   *
   * Per KEY, not per batcher: the bound the plan asks for is what one consumer
   * has to hold, and a consumer holds one frame at a time.
   */
  readonly maxBytes: number;
}

/**
 * The clock, injected.
 *
 * A port rather than a call to `setTimeout`, for the same reason `RunSession`
 * takes `now` and `clock` as functions: the tests measure a 10-minute slow
 * consumer, and a real timer makes that a 10-minute test. Everything time-based
 * here reads `now()` and schedules through `setTimer`, so a virtual clock
 * controls both without a single real timer being involved.
 */
export interface BatchClock {
  now(): number;
  /** Schedule `fn` after `delayMs`. The handle is opaque to this module. */
  setTimer(fn: () => void, delayMs: number): BatchTimer;
  clearTimer(timer: BatchTimer): void;
}

export type BatchTimer = unknown;

/** A clock backed by the host's real timers. */
export function systemBatchClock(): BatchClock {
  return {
    now: () => Date.now(),
    setTimer: (fn, delayMs) => setTimeout(fn, delayMs),
    clearTimer: (timer) => {
      clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  };
}

/** One published frame, and what it stands for. */
export interface CoalescingReceipt {
  readonly kind: 'coalesced';
  readonly runId: RunId;
  readonly eventType: EventType;
  readonly scope: CoalesceScope;
  /**
   * How many producer frames this ONE published frame represents.
   *
   * This is the whole gap-reporting shape for a merge, and the reason the answer
   * is "on the frame" rather than "in a metric". A metric says the run coalesced
   * well; only this says *this* frame stands for twelve, so a consumer that needs
   * to reconstruct how many updates it missed can, and one that does not can
   * ignore it. Content is identical either way - merging concatenates - so the
   * receipt is an accounting fact, never a repair instruction.
   */
  readonly producerFrames: number;
  readonly bytesSaved: number;
}

/** What one `offer` produced. */
export interface OfferResult {
  /**
   * Events to publish, in causal order, ready for the emitter.
   *
   * Empty exactly when the offered event was absorbed into a pending frame. An
   * absorbed event has NO envelope and no seq, so reporting an empty list is the
   * only honest result - returning a success with a fabricated envelope would be
   * the exact shape T3.2's emitter was built to avoid.
   */
  readonly emit: readonly RunEvent[];
  /** One receipt per emitted frame that stands for more than one producer frame. */
  readonly receipts: readonly CoalescingReceipt[];
}

/** Counters, and the high-water marks the plan asks a load test to record. */
export interface CoalescingMetrics {
  /** Producer frames offered. */
  readonly observedFrames: number;
  /** Frames handed onward for publication. */
  readonly publishedFrames: number;
  /** Producer frames absorbed into a neighbour (observed - published - dropped). */
  readonly coalescedFrames: number;
  /** Producer frames discarded. Always 0 here; the bounded queue owns dropping. */
  readonly droppedFrames: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly savedBytes: number;
  readonly pendingFrames: number;
  readonly pendingKeys: number;
  /** Most frames ever pending at once. */
  readonly highWaterFrames: number;
  /** Most bytes ever pending at once. */
  readonly highWaterBytes: number;
  /**
   * Producer frames published by flush reason. Sums to `coalescedFrames`.
   *
   * `offer_expired` is the path an `offer` takes when it finds its key's window
   * already expired; it is separated from `window` because the trigger there was
   * the producer rather than the timer, and a regression that moved a flush
   * between the two would otherwise be invisible.
   */
  readonly flushFrames: Readonly<Record<FlushReason, number>>;
  /**
   * Frames published without ever being held pending.
   *
   * Exists so the accounting has a closed identity rather than a plausible one:
   *
   *     observedFrames === sum(flushFrames) + pendingFrames + directPublished
   *
   * Every producer frame is either held (and then published under exactly one
   * flush reason), still held right now (`pendingFrames`), or published straight
   * away. A flush path that forgot to count itself breaks that identity, which is
   * how the `offer_expired` path was caught - and it is the check a load test
   * should run before believing a frame-reduction figure.
   */
  readonly directPublished: number;
}

export interface DeltaBatcherOptions {
  readonly runId: RunId;
  readonly thresholds: BatchThresholds;
  readonly clock: BatchClock;
  /** How a frame's size is measured. Defaults to the UTF-8 JSON length. */
  readonly measureBytes?: (event: RunEvent) => number;
}

/**
 * Why a pending frame was published.
 *
 * Named rather than counted in three separate fields, because the paths that
 * flush are not three: an offer arriving after its key's window has expired is a
 * fourth, and it is the one a busy stream takes most often. A counter per field
 * missed it once already; a closed union with one increment site cannot.
 */
export type FlushReason = 'barrier' | 'window' | 'bytes' | 'offer_expired' | 'explicit';

/** One key's accumulated frame. */
interface PendingEntry {  readonly key: CoalesceKey;
  /** The first producer frame, kept whole; later frames contribute only `delta`. */
  readonly base: RunEvent;
  delta: string;
  /** When this entry started, on the injected clock. The window is measured from here. */
  readonly openedAt: number;
  bytes: number;
  producerFrames: number;
  bytesIn: number;
  timer: BatchTimer | null;
  /** Guard against a stale timer firing for an entry that has already flushed. */
  live: boolean;
}

/**
 * The batcher for one run.
 *
 * Constructed once, in front of the run's emitter. It holds no ledger, no
 * session and no seq - it cannot number anything, and a batcher that could is a
 * second minting authority, which is the thing T3.2 spent its commit removing.
 */
export class DeltaBatcher {
  readonly #runId: RunId;
  readonly #thresholds: BatchThresholds;
  readonly #clock: BatchClock;
  readonly #measure: (event: RunEvent) => number;
  /**
   * Insertion-ordered, and that is load-bearing.
   *
   * On a flush every pending key is published in the order its FIRST delta was
   * seen, which is the causal order of the run's stream. A `Map` preserves
   * insertion order, so this is free; an object keyed by key string would also
   * have preserved it for non-numeric keys, but the property is wanted
   * explicitly and is asserted in the tests.
   */
  readonly #pending = new Map<string, PendingEntry>();

  #observedFrames = 0;
  #publishedFrames = 0;
  #coalescedFrames = 0;
  #bytesIn = 0;
  #bytesOut = 0;
  #savedBytes = 0;
  #pendingFrames = 0;
  #highWaterFrames = 0;
  #highWaterBytes = 0;
  #flushFrames: Record<FlushReason, number> = { barrier: 0, window: 0, bytes: 0, offer_expired: 0, explicit: 0 };
  #directPublished = 0;

  constructor(options: DeltaBatcherOptions) {
    this.#runId = options.runId;
    this.#thresholds = options.thresholds;
    this.#clock = options.clock;
    this.#measure = options.measureBytes ?? defaultMeasureBytes;
  }

  get runId(): RunId {
    return this.#runId;
  }

  /**
   * Offer one producer event.
   *
   * Three outcomes, and the order of the checks is the causal rule:
   *
   *  1. **A barrier** (anything not coalescable). Every pending frame is
   *     emitted BEFORE this event, then this event. The deltas come first
   *     because they happened first.
   *  2. **A coalescable event whose window has expired.** Its pending frame is
   *     emitted, then a new one is opened with this event - so the window is a
   *     real bound on staleness rather than a number that a busy stream can
   *     exceed indefinitely.
   *  3. **A coalescable event that fits.** Merged, published later.
   */
  offer(event: RunEvent): OfferResult {
    const incoming = this.#measure(event);
    this.#observedFrames += 1;
    this.#bytesIn += incoming;

    const key = coalesceKeyOf(this.#runId, event);
    // The barrier arm, and the reason `flush` is called BEFORE the event is
    // appended to the result rather than after.
    if (key === null) {
      return this.#compose(this.flush('barrier'), [event]);
    }

    const id = coalesceKeyId(key);
    const entry = this.#pending.get(id);

    if (entry === undefined) {
      // A single frame already at or over the byte bound is published on its
      // own rather than held: a frame cannot be split without inventing a
      // boundary the producer never chose, and holding it would let one huge
      // delta sit past the bound it alone caused.
      if (incoming >= this.#thresholds.maxBytes || this.#thresholds.windowMs <= 0) {
        this.#directPublished += 1;
        return this.#compose(this.#publish([event], incoming, 1, 0), []);
      }
      const opened = this.#open(key, id, event, incoming);
      this.#armWindow(opened);
      this.#noteHighWater();
      return { emit: [], receipts: [] };
    }

    const windowExpired =
      this.#thresholds.windowMs > 0 && this.#clock.now() - entry.openedAt >= this.#thresholds.windowMs;
    if (windowExpired) {
      // Close the stale frame first, then open a fresh one with this event, so
      // the new frame's window is measured from when it started.
      const flushed = this.#flushKey(entry, 'offer_expired');
      const opened = this.#open(key, id, event, incoming);
      this.#armWindow(opened);
      this.#noteHighWater();
      return this.#compose(flushed, []);
    }

    entry.delta += deltaOf(event);
    entry.producerFrames += 1;
    entry.bytesIn += incoming;
    entry.bytes = this.#measure(rebuild(entry));
    this.#pendingFrames += 1;
    this.#noteHighWater();

    if (entry.bytes >= this.#thresholds.maxBytes) {
      return this.#compose(this.#flushKey(entry, 'bytes'), []);
    }

    return { emit: [], receipts: [] };
  }

  /**
   * Publish every pending frame, in the order each key was first seen.
   *
   * The host calls this at a barrier it knows about from outside the batcher -
   * most importantly before the run's terminal, so a terminal is never
   * published while a delta it causally follows is still sitting in a buffer.
   */
  flush(reason: FlushReason = 'explicit'): OfferResult {
    if (this.#pending.size === 0) return EMPTY;
    const events: RunEvent[] = [];
    const receipts: CoalescingReceipt[] = [];
    for (const entry of [...this.#pending.values()]) {
      const result = this.#flushKey(entry, reason);
      events.push(...result.emit);
      receipts.push(...result.receipts);
    }
    return { emit: events, receipts };
  }

  /** Frames waiting to be published. */
  get pendingFrames(): number {
    return this.#pendingFrames;
  }

  /** Distinct keys waiting to be published. */
  get pendingKeys(): number {
    return this.#pending.size;
  }

  get metrics(): CoalescingMetrics {
    return {
      observedFrames: this.#observedFrames,
      publishedFrames: this.#publishedFrames,
      coalescedFrames: this.#coalescedFrames,
      droppedFrames: 0,
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      savedBytes: this.#savedBytes,
      pendingFrames: this.#pendingFrames,
      pendingKeys: this.#pending.size,
      highWaterFrames: this.#highWaterFrames,
      highWaterBytes: this.#highWaterBytes,
      flushFrames: this.#flushFrames,
      directPublished: this.#directPublished,
    };
  }

  /**
   * How many producer frames were saved as a fraction, in percent.
   *
   * A run that produced nothing reports 0 rather than NaN: "no frames, so no
   * saving" is the answer a load test should print, and `NaN` in a report is a
   * number nobody can read.
   */
  get frameReductionPercent(): number {
    if (this.#observedFrames === 0) return 0;
    return (this.#coalescedFrames / this.#observedFrames) * 100;
  }

  #open(key: CoalesceKey, id: string, event: RunEvent, bytes: number): PendingEntry {
    const entry: PendingEntry = {
      key,
      base: event,
      delta: deltaOf(event),
      openedAt: this.#clock.now(),
      bytes,
      producerFrames: 1,
      bytesIn: bytes,
      timer: null,
      live: true,
    };
    this.#pending.set(id, entry);
    this.#pendingFrames += 1;
    return entry;
  }

  /**
   * Arm the time window for one entry.
   *
   * `0` deliberately arms nothing: a window of zero would mean "flush as soon as
   * the clock ticks", and the correct reading of "no time bound" is no timer at
   * all rather than a timer that fires immediately.
   */
  #armWindow(entry: PendingEntry): void {
    if (this.#thresholds.windowMs <= 0) return;
    const armed = this.#clock.setTimer(() => {
      this.#onWindow(entry);
    }, this.#thresholds.windowMs);
    entry.timer = armed;
  }

  #onWindow(entry: PendingEntry): void {
    // A timer can outlive its entry: the byte threshold may have flushed this
    // key a moment earlier, and the handle is only cleared on the paths that run
    // before that. The identity check is what stops a stale callback from
    // publishing a frame a second time.
    if (!entry.live) return;
    const result = this.#flushKey(entry, 'window');
    this.#drain(result);
  }

  /**
   * Where a coalesced frame goes when no caller is waiting for it.
   *
   * The window firing with nobody calling `offer` has to publish SOMETHING: a
   * batcher that held the frame until the next offer would never coalesce an
   * idle stream and would make the window depend on the producer rather than on
   * time. So the batcher is given a sink for the timer-driven path, and the
   * `offer`-driven path returns results instead - one call site publishes, and
   * both paths go through it.
   */
  #onDetachedResult: ((result: OfferResult) => void) | null = null;

  /**
   * Where a timer-driven flush publishes.
   *
   * Required, and required up front, because otherwise a window firing between
   * two `offer` calls would publish into the void. The emitter-backed publisher
   * ({@link batchedPublisher}) sets it.
   */
  onDetachedFlush(sink: (result: OfferResult) => void): void {
    this.#onDetachedResult = sink;
  }

  #drain(result: OfferResult): void {
    if (result.emit.length === 0 && result.receipts.length === 0) return;
    this.#onDetachedResult?.(result);
  }

  /**
   * Close one entry and publish it. Idempotent per entry.
   *
   * The flush REASON is counted here and nowhere else, which is what makes the
   * accounting exact: an offer that arrives after a key's window has expired
   * flushes that key too, and an earlier draft counted only the timer and barrier
   * paths, so `flushFrames` did not sum to `coalescedFrames` and a load test
   * reading it would report a saving that had not happened. One place, one
   * increment.
   */
  #flushKey(entry: PendingEntry, reason: FlushReason): OfferResult {
    if (!entry.live) return EMPTY;
    entry.live = false;
    if (entry.timer !== null) {
      this.#clock.clearTimer(entry.timer);
      entry.timer = null;
    }
    this.#pending.delete(coalesceKeyId(entry.key));
    this.#pendingFrames -= entry.producerFrames;
    this.#flushFrames[reason] += entry.producerFrames;
    const event = rebuild(entry);
    const saved = Math.max(0, entry.bytesIn - entry.bytes);
    return this.#publish([event], entry.bytes, entry.producerFrames, saved, entry.key);
  }

  #publish(
    events: readonly RunEvent[],
    bytes: number,
    producerFrames: number,
    savedBytes: number,
    key?: CoalesceKey,
  ): OfferResult {
    for (const _ of events) this.#publishedFrames += 1;
    this.#coalescedFrames += Math.max(0, producerFrames - events.length);
    this.#bytesOut += bytes;
    this.#savedBytes += savedBytes;
    const receipts: CoalescingReceipt[] = [];
    if (key !== undefined && producerFrames > 1) {
      receipts.push({
        kind: 'coalesced',
        runId: key.runId,
        eventType: key.eventType,
        scope: key.scope,
        producerFrames,
        bytesSaved: savedBytes,
      });
    }
    return { emit: events, receipts };
  }

  /**
   * Join a flush with the event that triggered it.
   *
   * The tail events are counted as `directPublished` here rather than at their
   * call sites, because this is the only path by which a non-coalescable event
   * reaches publication: a barrier is never held pending, so it never passes
   * through `#flushKey` and no flush reason would otherwise claim it. Without
   * this the accounting identity came up one short per barrier - which is the
   * whole run's worth of tool calls and terminals.
   */
  #compose(first: OfferResult, tail: readonly RunEvent[]): OfferResult {
    if (tail.length === 0) return first;
    this.#directPublished += tail.length;
    return {
      emit: [...first.emit, ...tail],
      receipts: first.receipts,
    };
  }

  #noteHighWater(): void {
    if (this.#pendingFrames > this.#highWaterFrames) this.#highWaterFrames = this.#pendingFrames;
    let bytes = 0;
    for (const entry of this.#pending.values()) bytes += entry.bytes;
    if (bytes > this.#highWaterBytes) this.#highWaterBytes = bytes;
  }
}

const EMPTY: OfferResult = { emit: [], receipts: [] };

/** The concatenable field, or the empty string if a payload somehow lacks it. */
function deltaOf(event: RunEvent): string {
  switch (event.type) {
    case 'assistant.text_delta':
    case 'assistant.thinking_delta':
    case 'tool.arguments_delta':
      return event.delta;
    default:
      return '';
  }
}

/**
 * The accumulated frame.
 *
 * Rebuilt from the FIRST frame plus the concatenated `delta`, so every field
 * other than `delta` is the producer's own and was never inferred. A rebuild
 * that also recomputed, say, `index` would be a place where a merge could
 * change what the frame claims to be.
 */
function rebuild(entry: PendingEntry): RunEvent {
  const delta = entry.delta;
  switch (entry.base.type) {
    case 'assistant.text_delta':
    case 'assistant.thinking_delta':
    case 'tool.arguments_delta':
      return { ...entry.base, delta } as RunEvent;
    default:
      return entry.base;
  }
}

/**
 * The default size measure: UTF-8 bytes of the JSON form.
 *
 * The envelope is JSON on every transport this repo has, so its serialised
 * length is the real wire cost rather than an estimate. Injected so a host that
 * compresses or frames differently can measure what IT pays.
 */
export function defaultMeasureBytes(event: RunEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).length;
}

/**
 * The one thing this module needs from the emitter.
 *
 * Structural, and deliberately so: `RunEventEmitter` is the real implementation
 * in production and a two-method fake is the whole requirement in a test. Naming
 * the concrete class would have made every test reach for a real run session.
 */
export interface EventMinter {
  emit(event: RunEvent): { readonly ok: true } | { readonly ok: false };
}

/**
 * Wire a batcher in front of a run's emitter. One call, and it is the composition
 * this module's placement argument describes.
 *
 * Returning every `EmitResult` rather than only the last matters because a
 * barrier flushes N pending frames and then publishes the barrier, and a caller
 * that needs to know whether the BARRIER was refused would be told about the
 * wrong one otherwise. A refusal of any of them is returned in order.
 */
/** What the emitter answered for one published frame. */
export type EmitVerdict = { readonly ok: true } | { readonly ok: false };

export function batchedPublisher(
  batcher: DeltaBatcher,
  emitter: EventMinter,
): {
  publish(event: RunEvent): readonly EmitVerdict[];
  flush(): readonly EmitVerdict[];
} {
  const forward = (result: OfferResult) =>
    result.emit.map((event) => emitter.emit(event));
  // The window fires between calls, so it needs somewhere to publish.
  batcher.onDetachedFlush(forward);
  return {
    publish: (event: RunEvent) => forward(batcher.offer(event)),
    flush: () => forward(batcher.flush()),
  };
}

/**
 * A byte-bounded single-consumer queue, and what happens when it is full.
 *
 * ## The problem this answers
 *
 * Contract section F: `队列按bytes有界、单consumer契约明确；slowconsumer采用
 * coalescing/暂停产出或disconnect+replay，不阻塞取消/审批controlchannel`.
 *
 * `RunEventStream` is the existing bounded buffer and it is bounded by COUNT
 * (1024 frames) and sheds its oldest entry silently and type-blind. Both halves
 * are wrong for this contract, and neither is fixable by raising the number:
 *
 *  - **Count is not bytes.** 1024 frames of 20-byte deltas is 20 KB and 1024
 *    frames of tool arguments is megabytes. A memory bound stated in frames is
 *    not a memory bound.
 *  - **Silent, type-blind shedding is the forbidden loss.** Shifting out the
 *    oldest frame drops whatever it happened to be. If that was a `run.completed`
 *    the consumer now has a run with no ending, which is the single thing
 *    contract F's `不静默丢durable/terminal` forbids. A queue that sheds from the
 *    front has no way to honour "never delete the oldest terminal" - it is the
 *    opposite policy, applied uniformly because the queue cannot tell the frames
 *    apart. This queue can, so it does.
 *
 * ## The overflow decision, and why it is a decision rather than a default
 *
 * When the bound is reached the queue classifies the arriving frame and answers
 * one of four things. The classification comes from the registry's `durability`,
 * so it is the same table the emitter uses to decide persistence - not a second
 * opinion about which events matter.
 *
 *  - **Durable / terminal: RETAIN and PAUSE.** Never dropped, never merged. The
 *    frame is admitted even if that means briefly exceeding the bound by one
 *    frame, because the alternative is a run whose transcript has a hole. The
 *    queue then reports itself `paused`, and {@link BoundedEventQueue.whenWritable}
 *    is what a producer awaits. This is the "pause the producer" arm of the
 *    contract's three.
 *  - **Ephemeral and mergeable: MERGE.** Offered to a {@link DeltaBatcher}, so
 *    the frame still reaches the consumer as part of a bigger one. The bytes go
 *    down; the text does not.
 *  - **Ephemeral and NOT mergeable: DROP, and REPORT.** The gap is recorded as a
 *    {@link DeliveryGap} with a `kind`, a count and bytes, so a consumer can tell
 *    "nothing happened" from "something happened and was thrown away".
 *  - **Anything, once the pause has held too long: DISCONNECT.** A slow consumer
 *    that has stopped draining does not become fast, and holding a run's output
 *    in memory for the life of the process is its own failure. The queue asks its
 *    owner to disconnect so the consumer can replay from the store - the third
 *    arm of the contract's three, and the one that terminates.
 *
 * ## Drop-and-report is acceptable here, and pausing always would not be
 *
 * The judgement the brief asks to be made explicitly. Dropping *ephemeral,
 * unmergeable* frames is acceptable; pausing the producer for them is not,
 * because the cost is asymmetric and paid by the wrong party. A paused producer
 * is a stalled model call or a stalled tool: the run stops making progress
 * because one consumer stopped reading, and every other consumer of that run
 * stalls with it. The frame being dropped is, by construction, one the contract
 * permits to disappear - `tool.progress` percent ticks, a diagnostic line - and
 * the gap is reported. Trading the whole run's progress for one percentage point
 * is not a defensible default.
 *
 * The asymmetry is exactly why durable is not in the same branch: for a durable
 * frame the trade flips. A transcript with a hole is not recoverable by replay,
 * because the thing that was lost is what replay would have delivered. So
 * durable pauses, and the pause is reported rather than hidden.
 *
 * ## Single reader, enforced rather than documented
 *
 * One queue, one reader. Two iterators over it would steal each other's frames -
 * each `next()` shifts the head, so a second reader silently halves both
 * readers' streams and neither can tell. {@link BoundedEventQueue.read} therefore
 * refuses a second concurrent `next()` with a rejected promise rather than two
 * subtly-wrong streams. A host that genuinely needs two readers owns a tee:
 * `stream-fanout.ts`, which gives each subscriber its OWN queue.
 */

import type { EventType, RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { EVENT_REGISTRY } from '@duya/agent-protocol';
import { coalesceKeyId, coalesceKeyOf } from './coalesce.js';

/**
 * What the queue did with a frame.
 *
 * `queued` and `retained` are the untroubled cases - the frame is in the queue or
 * already on its way to the reader - and they are kept apart because `retained`
 * is the case where the queue went OVER its bound keeping a frame it refused to
 * drop, which is the fact a producer needs. The other three are the outcomes
 * under pressure.
 */
export type OverflowAction = 'queued' | 'retained' | 'merged' | 'dropped' | 'disconnected';

/**
 * A hole in what the consumer received, and its size.
 *
 * The shape the brief asks about: a consumer must be able to tell "nothing
 * happened" from "something happened and was merged away". So every gap names
 * WHAT was lost, HOW MUCH of it, and WHY - and `kind` distinguishes the two very
 * different cases:
 *
 *  - `dropped` is CONTENT LOSS. The consumer will never see those frames and no
 *    replay will produce them.
 *  - `merged` is NOT loss. The frames arrived, inside a bigger frame, and the
 *    receipt on that frame says how many it stands for. It is reported so a
 *    metrics consumer can distinguish 500 updates from 4, not so a reader can
 *    repair anything.
 *
 * `producerFrames` and `bytes` are required on both, so "how much did I miss" is
 * answerable without replaying anything.
 */
export interface DeliveryGap {
  readonly kind: 'dropped' | 'merged';
  readonly runId: RunId;
  readonly eventType: EventType;
  readonly producerFrames: number;
  readonly bytes: number;
  /** True when the loss is permanent rather than deferred to a replay. */
  readonly contentLost: boolean;
  readonly detail: string;
}

/** What the queue did with one offered frame. */
export interface EnqueueOutcome {
  readonly action: OverflowAction;
  /** Bytes the queue holds after this offer. */
  readonly bytes: number;
  /**
   * True when the queue is over its bound and the producer must stop.
   *
   * The producer's cue is {@link BoundedEventQueue.whenWritable}, not this
   * boolean: a pause is a state to wait out, and a flag the producer polls is a
   * spin loop waiting to be written badly.
   */
  readonly paused: boolean;
}

/** Counters a load test reads, and a host surfaces. */
export interface BackpressureMetrics {
  readonly offeredFrames: number;
  readonly deliveredFrames: number;
  readonly durableRetained: number;
  /** Ephemeral frames buffered because there was room for them. */
  readonly bufferedEphemeral: number;
  readonly ephemeralMerged: number;
  readonly ephemeralDropped: number;
  readonly droppedFrames: number;
  readonly droppedBytes: number;
  readonly highWaterBytes: number;
  readonly highWaterFrames: number;
  readonly pauseCount: number;
  readonly disconnectCount: number;
  /**
   * The lowest seq of a terminal the queue still holds.
   *
   * Reported rather than assumed: it is the direct check on "the oldest terminal
   * is never deleted", and a number that can be read is a claim that can be
   * tested.
   */
  readonly oldestTerminalSeq: number | null;
}

export interface BoundedEventQueueOptions {
  readonly runId: RunId;
  /** The byte bound. The one number that has to be right. */
  readonly maxBytes: number;
  /**
   * A frame count bound as well, for frames too small to reach the byte bound.
   *
   * Without it, a producer sending 4-byte deltas holds a million frames inside
   * a byte bound that never trips, and the queue is bounded in bytes only in a
   * sense that has nothing to do with memory per object. Both bounds are
   * checked; whichever trips first wins.
   */
  readonly maxFrames?: number;
  /** Overrides the size measure. Defaults to the envelope's UTF-8 JSON length. */
  readonly measureBytes?: (envelope: RunEventEnvelope) => number;
  /** Where gaps are reported, in addition to being retained. */
  readonly onGap?: (gap: DeliveryGap) => void;
  /**
   * A batcher is NOT offered to this queue, and the absence is a decision.
   *
   * The first version took one, to "merge instead of dropping" under pressure.
   * It is a cycle: the batcher sits UPSTREAM of seq assignment and this queue
   * sits downstream of it, so a frame the batcher flushes lands here, which hands
   * it straight back to the batcher, which holds it until the next flush - which
   * is never coming, because the producer has moved on. Measured, that stranded
   * the tail of every run: content equality failed on 9 of 12 load scenarios while
   * the frame-reduction figures still looked excellent, because the text was not
   * lost in transit, it was sitting in a buffer nobody owned.
   *
   * So coalescing lives in exactly one place, upstream, and this queue reduces
   * its OWN occupancy by merging two frames it already holds. See
   * {@link BoundedEventQueue.mergeIntoQueued}.
   */
  /**
   * How long a pause may hold before the queue asks to be disconnected.
   *
   * The escape from a slow consumer that is not going to recover. `null` means
   * never disconnect, which is correct only for an in-process consumer the host
   * already knows to be bounded.
   */
  readonly pauseTimeoutMs?: number | null;
  /**
   * Asked to disconnect the slow consumer.
   *
   * Deliberately a callback and not a method this class calls on a consumer: the
   * queue owns frames, and WHAT to disconnect is the host's decision. The queue
   * raises the fact; the transport acts on it.
   */
  readonly onDisconnect?: (reason: { readonly reason: 'slow_consumer'; readonly heldMs: number }) => void;
  /** The wall clock the pause timeout is measured on. Injectable for tests. */
  readonly clock?: () => number;
}

/**
 * One queued frame, its cost, and the merge key it could be folded into.
 *
 * The key is computed once on the way in rather than on every overflow, so the
 * merge search is a string compare over already-known ids instead of
 * re-deriving keys from payloads for every frame in the queue.
 */
interface Slot {
  readonly envelope: RunEventEnvelope;
  readonly bytes: number;
  readonly terminal: boolean;
  /** `null` for a frame that may never merge with anything. */
  readonly keyId: string | null;
}

/**
 * True for the frames that may never be evicted.
 *
 * Read from the registry: a terminal is critical AND durable, but naming it
 * separately keeps the rule legible at the eviction site, where it is the reason
 * one candidate is skipped and another is not. `tool.progress` is the
 * instructive non-example - `volatile`, so retained rather than dropped, because
 * dropping it is not something this queue is allowed to decide silently.
 */
function isRetainable(envelope: RunEventEnvelope): boolean {
  const type = (envelope.payload as { readonly type?: unknown }).type;
  if (typeof type !== 'string') return true;
  const durability = EVENT_REGISTRY.specOf(type)?.durability;
  return durability !== 'ephemeral';
}

/**
 * A byte-bounded queue with one reader.
 *
 * `EventSource`-shaped at the edge (`[Symbol.asyncIterator]` yields envelopes
 * and `close()` ends it) but NOT declared as implementing `EventSource`: this
 * class's iterator is deliberately single-reader, and a structural match that
 * let two consumers iterate one queue would make the contract unenforced.
 */
export class BoundedEventQueue {
  readonly #runId: RunId;
  readonly #maxBytes: number;
  readonly #maxFrames: number;
  readonly #measure: (envelope: RunEventEnvelope) => number;
  readonly #onGap: ((gap: DeliveryGap) => void) | undefined;
  readonly #pauseTimeoutMs: number | null;
  readonly #onDisconnect: ((reason: { readonly reason: 'slow_consumer'; readonly heldMs: number }) => void) | undefined;
  readonly #clock: () => number;

  readonly #slots: Slot[] = [];
  readonly #waiters: Array<(result: IteratorResult<RunEventEnvelope>) => void> = [];
  readonly #writableWaiters: Array<() => void> = [];
  readonly #gaps: DeliveryGap[] = [];
  #bytes = 0;
  #closed = false;
  /**
   * Whether a consumer has taken this queue.
   *
   * Claimed by the async ITERATOR, for the queue's whole lifetime, rather than
   * per `read()` call: one consumer reading in a loop must be able to call
   * `read()` as many times as it likes, and what must be refused is a second
   * consumer. A guard that counted calls would break the legitimate reader; a
   * guard that only checked the pending case would miss two iterators over a
   * queue that already had frames, which is exactly the case that halves both
   * streams silently.
   */
  #readerClaimed = false;
  /** A `read()` is pending. Two at once is two consumers. */
  #inFlight = false;

  #pausedSince: number | null = null;
  #paused = false;
  #offeredFrames = 0;
  #deliveredFrames = 0;
  #durableRetained = 0;
  #bufferedEphemeral = 0;
  #ephemeralMerged = 0;
  #ephemeralDropped = 0;
  #droppedBytes = 0;
  #highWaterBytes = 0;
  #highWaterFrames = 0;
  #pauseCount = 0;
  #disconnectCount = 0;
  #oldestTerminalSeq: number | null = null;

  constructor(options: BoundedEventQueueOptions) {
    this.#runId = options.runId;
    this.#maxBytes = options.maxBytes;
    this.#maxFrames = options.maxFrames ?? Number.POSITIVE_INFINITY;
    this.#measure = options.measureBytes ?? defaultEnvelopeBytes;
    this.#onGap = options.onGap;
    this.#pauseTimeoutMs = options.pauseTimeoutMs ?? null;
    this.#onDisconnect = options.onDisconnect;
    this.#clock = options.clock ?? Date.now;
  }

  get runId(): RunId {
    return this.#runId;
  }

  /** Bytes currently held. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Frames currently held. */
  get frames(): number {
    return this.#slots.length;
  }

  /** True when the queue is over its bound and wants the producer to wait. */
  get paused(): boolean {
    return this.#paused;
  }

  /** Gaps recorded so far. The host's to read; the queue does not clear them. */
  get gaps(): readonly DeliveryGap[] {
    return this.#gaps;
  }

  get metrics(): BackpressureMetrics {
    return {
      offeredFrames: this.#offeredFrames,
      deliveredFrames: this.#deliveredFrames,
      durableRetained: this.#durableRetained,
      bufferedEphemeral: this.#bufferedEphemeral,
      ephemeralMerged: this.#ephemeralMerged,
      ephemeralDropped: this.#ephemeralDropped,
      droppedFrames: this.#ephemeralDropped,
      droppedBytes: this.#droppedBytes,
      highWaterBytes: this.#highWaterBytes,
      highWaterFrames: this.#highWaterFrames,
      pauseCount: this.#pauseCount,
      disconnectCount: this.#disconnectCount,
      oldestTerminalSeq: this.#oldestTerminalSeq,
    };
  }

  /**
   * Offer one envelope. Never throws, never blocks.
   *
   * Non-blocking is the property that keeps the control channel alive: a
   * producer that could be made to WAIT here would be a producer holding a turn
   * of a model call hostage to a consumer's read rate, and the cancel that would
   * release it would have to travel the same road.
   */
  enqueue(envelope: RunEventEnvelope): EnqueueOutcome {
    this.#offeredFrames += 1;
    // Checked before the frame is classified, because time passing is itself the
    // trigger: a pause that started two minutes ago and is still holding needs
    // the disconnect asked for whether or not another frame arrives.
    this.#maybeDisconnect();
    if (this.#closed) {
      this.#noteDrop(envelope, this.#measure(envelope), 'the queue is closed');
      return { action: 'dropped', bytes: this.#bytes, paused: false };
    }

    const bytes = this.#measure(envelope);
    const type = frameType(envelope);

    // Durable and terminal frames are admitted whatever the bound says, and the
    // queue is then over its bound and says so. Admitting first and reporting
    // the overflow second is the only order in which durable loss is zero.
    if (isRetainable(envelope)) {
      const terminal = isTerminalFrame(envelope);
      this.#accept(envelope, bytes, terminal, true);
      if (this.#over()) this.#enterPause();
      return { action: 'retained', bytes: this.#bytes, paused: this.#paused };
    }

    // Ephemeral, and there is ROOM. It is delivered like anything else.
    //
    // This arm was missing and it mattered: an earlier version sent every
    // ephemeral frame straight to the merge-or-drop branch, so a subscriber with
    // no batcher lost its deltas even when the queue was empty and the consumer
    // was keeping up. The contract permits coalescing and dropping "under
    // pressure"; dropping a frame nobody was struggling to deliver is a loss the
    // contract never authorised, and it is invisible in a metrics reading because
    // the drop count looks the same as a legitimate one.
    if (!this.#over()) {
      this.#accept(envelope, bytes, false, false);
      return { action: 'queued', bytes: this.#bytes, paused: false };
    }

    // Ephemeral, and OVER the bound. If a queued frame of the same merge key is
    // already here, fold this one into it: the consumer still gets the content,
    // and the queue holds one frame fewer. Merging into the queue's OWN contents
    // is what keeps this from being a reference back upstream.
    if (this.mergeIntoQueued(envelope, bytes)) {
      this.#ephemeralMerged += 1;
      this.#recordGap('merged', type, 1, bytes, 'merged into a frame already queued');
      return { action: 'merged', bytes: this.#bytes, paused: false };
    }

    // Ephemeral, over the bound, and nothing to merge into: it goes, and the hole
    // is recorded rather than left for a consumer to mistake for silence.
    this.#noteDrop(envelope, bytes, 'ephemeral and nothing left to merge into');
    return { action: 'dropped', bytes: this.#bytes, paused: false };
  }

  /**
   * Fold an ephemeral frame into a queued frame of the same merge key.
   *
   * The key comes from `coalesce.ts`, so there is ONE definition of "these two
   * frames may become one" in the runtime rather than a second list in this file
   * that could drift from it - and therefore a second place where text could be
   * welded onto thinking.
   *
   * Returns false when there is nothing to merge into, which sends the caller to
   * the drop path with the reason reported.
   */
  mergeIntoQueued(envelope: RunEventEnvelope, bytes: number): boolean {
    const key = coalesceKeyOf(this.#runId, envelope.payload);
    if (key === null) return false;
    const id = coalesceKeyId(key);
    for (const slot of this.#slots) {
      if (slot.keyId !== id) continue;
      const merged = mergeQueuedEnvelopes(slot.envelope, envelope);
      if (merged === null) return false;
      const mergedBytes = this.#measure(merged);
      this.#bytes += mergedBytes - slot.bytes;
      this.#slots[this.#slots.indexOf(slot)] = { ...slot, envelope: merged, bytes: mergedBytes };
      this.#noteHighWater();
      return true;
    }
    return false;
  }

  /**
   * Take the next frame. The single reader.
   *
   * Claims the queue for this reader on the first call and refuses every later
   * claim, so two consumers cannot silently split the stream.
   */
  async read(): Promise<IteratorResult<RunEventEnvelope>> {
    // Concurrency, not call count. One consumer reading in a loop must be able
    // to call `read()` as often as it likes; what cannot be allowed is a second
    // read pending at the same time, because both would shift the head and each
    // would receive part of the stream.
    if (this.#inFlight) {
      throw new Error(
        'BoundedEventQueue has a single reader: two handles cannot share one queue, so use a FanOutBroker',
      );
    }
    const slot = this.#slots.shift();
    if (slot !== undefined) {
      this.#releaseBytes(slot.bytes);
      return { value: slot.envelope, done: false };
    }
    if (this.#closed) return { value: undefined, done: true };
    this.#inFlight = true;
    return new Promise<IteratorResult<RunEventEnvelope>>((resolve) => {
      this.#waiters.push((result) => {
        this.#inFlight = false;
        if (result.done !== true) this.#releaseBytes(0);
        resolve(result);
      });
    });
  }

  /** True once a reader has claimed this queue. */
  get hasReader(): boolean {
    return this.#readerClaimed;
  }

  /**
   * Re-run the pause timeout check.
   *
   * Exposed because a queue that is idle does not see time pass: with no frames
   * arriving there is no `enqueue` to re-check from, so a host that wants a
   * pause to escalate on a timer needs somewhere to say so. The disconnect is
   * the queue's own decision; this is only the nudge.
   */
  recheckBackpressure(): void {
    this.#maybeDisconnect();
  }

  #claimReader(): void {
    if (this.#readerClaimed) {
      throw new Error(
        'BoundedEventQueue has a single reader: two handles cannot share one queue, so use a FanOutBroker',
      );
    }
    this.#readerClaimed = true;
  }

  /**
   * Accept one frame into the queue, waking a waiting reader.
   *
   * The wake is part of accepting, not a separate concern. An earlier version
   * pushed onto `#slots` and never touched `#waiters`, so a reader that had
   * already found the queue empty waited there while frames arrived behind it -
   * a queue that stalls its own consumer. Caught by a test that enqueued after
   * the iterator had started.
   */
  #accept(envelope: RunEventEnvelope, bytes: number, terminal: boolean, retainable: boolean): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      // Handed straight to the waiting reader: not buffered, so a queue whose
      // consumer is merely slow does not accumulate copies of what it is about
      // to be handed anyway.
      waiter({ value: envelope, done: false });
      return;
    }
    const key = coalesceKeyOf(this.#runId, envelope.payload);
    this.#slots.push({ envelope, bytes, terminal, keyId: key === null ? null : coalesceKeyId(key) });
    this.#bytes += bytes;
    if (retainable) this.#durableRetained += 1;
    else this.#bufferedEphemeral += 1;
    if (terminal) {
      this.#oldestTerminalSeq ??= envelope.seq;
    }
    this.#noteHighWater();
  }

  /**
   * Account for one frame reaching its reader.
   *
   * `bytes` is 0 for a frame handed straight to a waiting reader, because that
   * frame was never buffered and there are no bytes to give back - counting
   * them twice is how a slow-consumer run ends up reporting a queue that went
   * negative.
   */
  #releaseBytes(bytes: number): void {
    if (bytes > 0) this.#bytes -= bytes;
    this.#deliveredFrames += 1;
    if (!this.#over()) this.#exitPause();
  }

  /** Async iteration over the single reader. */
  async *[Symbol.asyncIterator](): AsyncIterator<RunEventEnvelope> {
    this.#claimReader();
    for (;;) {
      const next = await this.read();
      if (next.done === true) return;
      yield next.value;
    }
  }

  /**
   * Resolves when the queue is back inside its bound, or immediately if it
   * never went over.
   *
   * What a producer awaits instead of polling `paused`. Resolves on every read
   * that brings the queue under the bound, so a host that awaits it and then
   * offers again is not busy-waiting.
   */
  whenWritable(): Promise<void> {
    if (!this.#paused) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#writableWaiters.push(resolve);
    });
  }


  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0, this.#waiters.length)) {
      waiter({ value: undefined, done: true });
    }
    for (const waiter of this.#writableWaiters.splice(0, this.#writableWaiters.length)) waiter();
  }

  #over(): boolean {
    return this.#bytes > this.#maxBytes || this.#slots.length > this.#maxFrames;
  }

  #enterPause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#pauseCount += 1;
    this.#pausedSince = this.#clock();
    this.#maybeDisconnect();
  }

  #exitPause(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#pausedSince = null;
    for (const waiter of this.#writableWaiters.splice(0, this.#writableWaiters.length)) waiter();
  }

  #maybeDisconnect(): void {
    if (this.#pauseTimeoutMs === null || this.#onDisconnect === undefined) return;
    if (this.#pausedSince === null) return;
    if (this.#clock() - this.#pausedSince < this.#pauseTimeoutMs) return;
    if (this.#disconnectCount > 0) return;
    this.#disconnectCount += 1;
    this.#onDisconnect({ reason: 'slow_consumer', heldMs: this.#clock() - this.#pausedSince });
  }

  #noteHighWater(): void {
    if (this.#bytes > this.#highWaterBytes) this.#highWaterBytes = this.#bytes;
    if (this.#slots.length > this.#highWaterFrames) this.#highWaterFrames = this.#slots.length;
  }

  #noteDrop(envelope: RunEventEnvelope, bytes: number, detail: string): void {
    this.#recordGap('dropped', frameType(envelope), 1, bytes, detail);
    this.#ephemeralDropped += 1;
    this.#droppedBytes += bytes;
  }

  #recordGap(
    kind: DeliveryGap['kind'],
    eventType: EventType,
    producerFrames: number,
    bytes: number,
    detail: string,
  ): void {
    const gap: DeliveryGap = {
      kind,
      runId: this.#runId,
      eventType,
      producerFrames,
      bytes,
      // Only a drop is a loss. A merge is deferred to a frame that is still on
      // its way, and telling a consumer otherwise would make it go looking for
      // content it already has.
      contentLost: kind === 'dropped',
      detail,
    };
    this.#gaps.push(gap);
    this.#onGap?.(gap);
  }
}

/** The frames whose eviction this queue refuses. See {@link isRetainable}. */
function isTerminalFrame(envelope: RunEventEnvelope): boolean {
  const type = (envelope.payload as { readonly type?: unknown }).type;
  return type === 'run.completed' || type === 'run.failed';
}

/**
 * Concatenate two envelopes of one merge key into the first.
 *
 * The envelope identity is kept from `into` and only `delta` is concatenated -
 * `seq`, `timestamp` and every other envelope field stay exactly as the ledger
 * minted them. That is the same rule the batcher follows, and it matters here for
 * a sharper reason: a queued frame has already been PUBLISHED, so rewriting
 * anything but its payload would be changing something a consumer may already be
 * holding. The `seq` of the merged frame stays the one it was given, and the
 * receipt recorded on the gap is what says how many producer frames it now
 * stands for.
 *
 * `null` when the pair is not a mergeable delta pair, which sends the caller to
 * the drop path.
 */
function mergeQueuedEnvelopes(
  into: RunEventEnvelope,
  from: RunEventEnvelope,
): RunEventEnvelope | null {
  const intoPayload = into.payload as unknown as Readonly<Record<string, unknown>>;
  const fromPayload = from.payload as unknown as Readonly<Record<string, unknown>>;
  const intoDelta = deltaOf(intoPayload);
  const fromDelta = deltaOf(fromPayload);
  if (intoDelta === null || fromDelta === null) return null;
  if (intoPayload['type'] !== fromPayload['type']) return null;
  return {
    ...into,
    payload: { ...intoPayload, delta: intoDelta + fromDelta } as unknown as RunEventEnvelope['payload'],
  };
}

/** The concatenable field of a mergeable frame, or `null` if it has none. */
function deltaOf(payload: Readonly<Record<string, unknown>>): string | null {
  switch (payload['type']) {
    case 'assistant.text_delta':
    case 'assistant.thinking_delta':
    case 'tool.arguments_delta':
      return typeof payload['delta'] === 'string' ? (payload['delta'] as string) : null;
    default:
      return null;
  }
}

function frameType(envelope: RunEventEnvelope): EventType {
  const type = (envelope.payload as { readonly type?: unknown }).type;
  return typeof type === 'string' && EVENT_REGISTRY.isKnown(type) ? type : 'diagnostic';
}

/** UTF-8 bytes of an envelope's JSON form - the real wire cost. */
export function defaultEnvelopeBytes(envelope: RunEventEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}

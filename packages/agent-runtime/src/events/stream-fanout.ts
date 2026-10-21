/**
 * The tee: one publisher, N subscribers, N queues.
 *
 * ## The question T3.4 item 5 asks
 *
 * `多handleconsumer不得互抢同queue` - multiple handle consumers must not fight
 * over one queue. That is not a style rule here; it is a correctness property of
 * a queue whose `read()` shifts the head. Two handles iterating one
 * `BoundedEventQueue` each get half the frames, interleaved arbitrarily, and
 * neither can detect it: both see a well-formed, gapless-ish prefix. The UI
 * shows half a sentence and persistence stores half a transcript, and the bug
 * looks like a rendering glitch for months.
 *
 * So the contract is stated once, here, and enforced at the only place it can be:
 *
 *  - **A queue has exactly one reader.** `BoundedEventQueue.read` throws on a
 *    second concurrent call rather than splitting the stream quietly.
 *  - **A fan-out is N queues.** {@link FanOutBroker} gives each subscriber its
 *    own {@link BoundedEventQueue} and copies into all of them. Two readers, two
 *    queues, no sharing, no stealing.
 *
 * ## Who owns the tee, stated as an ownership
 *
 * The broker's doc comment is not decoration - the brief asks for the tee or
 * broker responsibility to be NAMED for a host that needs both a UI reader and a
 * persistence reader, and the naming is the deliverable:
 *
 *  - **The host owns the broker, not the run handle.** A `RunHandle` keeps
 *    offering one stream; a host that wants a second reader constructs a broker,
 *    attaches to it, and owns both subscriptions' lifetimes. This keeps
 *    `RunHandle`'s contract single-reader, which is the property a caller
 *    already relies on.
 *  - **The broker is a BROKER, not a buffer.** It holds no frames of its own -
 *    it has no queue, no bound, no eviction policy - and a slow subscriber is
 *    bounded by ITS OWN queue's policy. If the broker buffered, that buffer would
 *    be an unbounded queue sitting in front of the bounded ones, which is the
 *    exact defect `backpressure.ts` exists to remove.
 *  - **Backpressure is per subscriber, and that is a real cost.** A fast UI and a
 *    slow persistence reader diverge: the UI sees everything, persistence sees
 *    what it kept plus the `DeliveryGap`s it recorded. That is the honest
 *    outcome, and the gaps are how the host knows to replay rather than assume.
 *
 * ## `RunEventTap` already existed, and this is the other half of it
 *
 * T3.3's `openReplaySubscription` takes a `RunEventTap` and its header already
 * said the tap is a tee and that who owns it is a transport decision (T3.5's).
 * That was the consuming half. This is the producing half: a concrete broker that
 * satisfies the same shape, so the port T3.3 defined has an implementation whose
 * single-reader property can be tested rather than asserted.
 */

import type { RunEventEnvelope, RunId } from '@duya/agent-protocol';
import { BoundedEventQueue, type BoundedEventQueueOptions } from './backpressure.js';

/** One subscriber's queue and the detach that ends it. */
interface Subscription {
  readonly id: number;
  readonly queue: BoundedEventQueue;
}

/**
 * Fans one run's published envelopes out to N independent single-reader queues.
 *
 * Implements the `RunEventTap` shape T3.3's `openReplaySubscription` consumes -
 * `attach(listener)` returning a detach - so a replay subscription can be
 * attached to this broker with no adaptation.
 */
export class FanOutBroker {
  readonly #runId: RunId;
  readonly #subscriptions: Subscription[] = [];
  #nextId = 1;

  constructor(runId: RunId) {
    this.#runId = runId;
  }

  get runId(): RunId {
    return this.#runId;
  }

  /** Live subscriptions. */
  get subscribers(): number {
    return this.#subscriptions.length;
  }

  /**
   * Attach a bare listener, returning a detach.
   *
   * The `RunEventTap` shape. Not the usual path: a listener has no bound and no
   * backpressure policy of its own, so it is offered for the replay
   * subscription's use and for tests. A host serving a UI should use
   * {@link subscribe}, because a listener cannot be bounded and an unbounded
   * reader is the failure this package is about.
   */
  attach(listener: (envelope: RunEventEnvelope) => void): () => void {
    const subscription: Subscription = {
      id: this.#nextId++,
      queue: new BoundedEventQueue({ runId: this.#runId, maxBytes: Number.MAX_SAFE_INTEGER }),
    };
    this.#subscriptions.push(subscription);
    // The listener is driven by the subscriber's own queue, so the broker's copy
    // is still an ordinary single-reader queue and the listener cannot starve
    // another subscriber.
    void (async () => {
      for await (const envelope of subscription.queue) {
        listener(envelope);
      }
    })();
    return () => {
      this.#detach(subscription);
    };
  }

  /**
   * Give one subscriber its OWN bounded queue, and the detach that ends it.
   *
   * The API a host with two readers uses. `options` is the SUBSCRIBER's policy -
   * its own `maxBytes`, its own gap callback, its own pause timeout - because
   * the point of the tee is that one slow reader does not decide for the others.
   */
  subscribe(options: Omit<BoundedEventQueueOptions, 'runId'>): {
    readonly id: number;
    readonly queue: BoundedEventQueue;
    detach: () => void;
  } {
    const subscription: Subscription = {
      id: this.#nextId++,
      queue: new BoundedEventQueue({ ...options, runId: this.#runId }),
    };
    this.#subscriptions.push(subscription);
    return {
      id: subscription.id,
      queue: subscription.queue,
      detach: () => {
        this.#detach(subscription);
      },
    };
  }

  /**
   * Publish one envelope to every subscriber.
   *
   * The single place frames are copied, so it is the only place where a
   * subscriber could be missed - and it cannot miss one: a subscriber that has
   * detached is removed from the list, and a subscriber that is still attached is
   * offered. What a subscriber does with the frame afterwards (keep it, merge
   * it, drop it, pause) is its own queue's policy, and the divergence that
   * creates is reported through that queue's `DeliveryGap`s rather than hidden
   * here.
   */
  publish(envelope: RunEventEnvelope): void {
    for (const subscription of [...this.#subscriptions]) {
      subscription.queue.enqueue(envelope);
    }
  }

  /** End every subscription. The broker's own frames - it has none - are unaffected. */
  close(): void {
    for (const subscription of this.#subscriptions.splice(0, this.#subscriptions.length)) {
      subscription.queue.close();
    }
  }

  #detach(subscription: Subscription): void {
    const index = this.#subscriptions.indexOf(subscription);
    if (index === -1) return;
    this.#subscriptions.splice(index, 1);
    subscription.queue.close();
  }
}

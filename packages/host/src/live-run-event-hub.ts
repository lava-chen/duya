import type { AgentRunEventStreamQuery, RunEventEnvelope, RunId } from '@duya/agent-protocol';

const MAX_RETAINED_EVENTS = 4096;
const CLOSED_RUN_RETENTION_MS = 60_000;

interface LiveRunChannel {
  readonly events: RunEventEnvelope[];
  readonly waiters: Set<() => void>;
  lastSeq: number;
  closed: boolean;
}

/** Bounded, process-local stream for events that are intentionally not durable. */
export class LiveRunEventHub {
  readonly #channels = new Map<RunId, LiveRunChannel>();

  open(runId: RunId): void {
    this.#channel(runId);
  }

  publish(envelope: RunEventEnvelope): void {
    if (envelope.payload.type === 'run.completed' || envelope.payload.type === 'run.failed') return;
    const channel = this.#channel(envelope.runId);
    if (channel.closed || envelope.seq <= channel.lastSeq) return;

    channel.lastSeq = envelope.seq;
    channel.events.push(envelope);
    if (channel.events.length > MAX_RETAINED_EVENTS) {
      channel.events.splice(0, channel.events.length - MAX_RETAINED_EVENTS);
    }
    this.#wake(channel);
  }

  close(runId: RunId): void {
    const channel = this.#channel(runId);
    if (channel.closed) return;
    channel.closed = true;
    this.#wake(channel);
    const timer = setTimeout(() => {
      if (this.#channels.get(runId) === channel) this.#channels.delete(runId);
    }, CLOSED_RUN_RETENTION_MS);
    timer.unref?.();
  }

  watch(runId: RunId, query: AgentRunEventStreamQuery = {}): AsyncIterable<RunEventEnvelope> | null {
    const channel = this.#channels.get(runId);
    if (channel === undefined) return null;
    return this.#iterate(channel, query.afterSeq ?? 0, query.signal);
  }

  #channel(runId: RunId): LiveRunChannel {
    const existing = this.#channels.get(runId);
    if (existing !== undefined) return existing;
    const created: LiveRunChannel = {
      events: [],
      waiters: new Set(),
      lastSeq: 0,
      closed: false,
    };
    this.#channels.set(runId, created);
    return created;
  }

  async *#iterate(
    channel: LiveRunChannel,
    afterSeq: number,
    signal?: AbortSignal,
  ): AsyncIterableIterator<RunEventEnvelope> {
    let cursor = afterSeq;
    while (signal?.aborted !== true) {
      const next = findEventAfter(channel.events, cursor);
      if (next !== undefined) {
        cursor = next.seq;
        yield next;
        continue;
      }
      if (channel.closed) return;
      await this.#wait(channel, signal);
    }
  }

  #wait(channel: LiveRunChannel, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = (): void => {
        channel.waiters.delete(wake);
        signal?.removeEventListener('abort', wake);
        resolve();
      };
      channel.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
      if (signal?.aborted === true) wake();
    });
  }

  #wake(channel: LiveRunChannel): void {
    for (const wake of channel.waiters) wake();
  }
}

function findEventAfter(
  events: readonly RunEventEnvelope[],
  cursor: number,
): RunEventEnvelope | undefined {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (events[middle]!.seq <= cursor) low = middle + 1;
    else high = middle;
  }
  return events[low];
}

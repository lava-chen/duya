/**
 * Fixtures for the browser transport tests.
 *
 * Envelopes are built as real protocol events and handed to a real
 * `RunSession`. The point of the transport tests is that the browser's framing,
 * cursor and admission behaviour compose correctly with the shared surface, and
 * a mocked surface would test the mock.
 */

import type {
  RunEventEnvelope,
  RunId,
  SessionId,
  ToolCallId,
  TurnId,
} from '@duya/agent-protocol';

export const RUN_ID = 'run-web-transport' as RunId;
export const SESSION_ID = 'session-web-transport' as SessionId;

const encoder = new TextEncoder();

let clock = 1_700_000_000_000;

/** Monotonic envelope timestamps, so ordering assertions have something to read. */
function nextTimestamp(): number {
  clock += 1;
  return clock;
}

export function resetClock(): void {
  clock = 1_700_000_000_000;
}

function envelope(runId: RunId, sessionId: SessionId, seq: number, payload: Record<string, unknown>): RunEventEnvelope {
  return {
    runId,
    sessionId,
    seq,
    timestamp: nextTimestamp(),
    traceId: 'trace-web-transport',
    payload: payload as unknown as RunEventEnvelope['payload'],
  };
}

export function runStarted(seq: number, runId: RunId = RUN_ID, sessionId: SessionId = SESSION_ID): RunEventEnvelope {
  return envelope(runId, sessionId, seq, {
    type: 'run.started',
    manifestHash: 'manifest-hash',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'web-transport-test', version: '1' },
  });
}

export function turnStarted(seq: number, turnId: TurnId = 'turn-1'): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'turn.started',
    turnId,
    index: 1,
    model: 'test-model',
    providerId: 'test-provider',
    apiFormat: 'anthropic',
  });
}

export function turnCompleted(seq: number, turnId: TurnId = 'turn-1'): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'turn.completed',
    turnId,
    index: 1,
    stopReason: 'end_turn',
  });
}

export function textDelta(seq: number, messageId: string, delta: string): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'assistant.text_delta',
    messageId,
    index: 0,
    delta,
  });
}

export function messageFinalized(seq: number, messageId: string, text: string): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'assistant.message_finalized',
    messageId,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
  });
}

export function toolStarted(
  seq: number,
  toolCallId: ToolCallId = 'tool-1',
  toolName = 'read_file',
): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'tool.call_started',
    toolCallId,
    toolName,
    arguments: { path: 'README.md' },
    attempt: 1,
  });
}

export function toolCompleted(seq: number, toolCallId: ToolCallId = 'tool-1'): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, {
    type: 'tool.call_completed',
    toolCallId,
    content: 'ok',
    outcome: 'success',
    durationMs: 12,
  });
}

export function runCompleted(seq: number, status = 'completed'): RunEventEnvelope {
  return envelope(RUN_ID, SESSION_ID, seq, { type: 'run.completed', status });
}

/** One SSE frame exactly as the BFF writes it. */
export function frame(seq: number, payload: unknown): string {
  return `id: ${seq}\nevent: run\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function frameFor(event: RunEventEnvelope): string {
  return frame(event.seq, event);
}

export function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * A stream the test drives by hand.
 *
 * Pushing bytes in the middle of a multi-byte character is the whole point:
 * that is the case a per-chunk `decode()` gets wrong, and it only shows up on
 * text a reader is looking at.
 */
export class StubStream {
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly body: ReadableStream<Uint8Array>;

  constructor() {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
    });
  }

  pushBytes(chunk: Uint8Array): void {
    // A stopped stream has already been torn down by its abort; writing to it
    // is a no-op rather than an exception, so a test can stop first and still
    // poke at the handle afterwards.
    try {
      this.#controller?.enqueue(chunk);
    } catch {
      // already closed
    }
  }

  push(text: string): void {
    this.pushBytes(bytes(text));
  }

  /** Split `text` at a byte offset and deliver the halves as separate chunks. */
  pushSplit(text: string, offset: number): void {
    const all = bytes(text);
    this.pushBytes(all.slice(0, offset));
    this.pushBytes(all.slice(offset));
  }

  close(): void {
    try {
      this.#controller?.close();
    } catch {
      // already closed
    }
  }

  fail(error: unknown): void {
    try {
      this.#controller?.error(error);
    } catch {
      // already closed
    }
  }
}

export interface RecordedRequest {
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

/**
 * A `fetch` stand-in that hands out streams in order and records what it was
 * asked for, so a test can assert on the resume cursor rather than on internal
 * bookkeeping.
 */
export function createStreamFetch(): {
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly requests: RecordedRequest[];
  readonly streams: StubStream[];
} {
  const requests: RecordedRequest[] = [];
  const streams: StubStream[] = [];

  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url: input, signal: init?.signal ?? undefined });
    const stream = new StubStream();
    streams.push(stream);
    // A real `fetch` tears the body down when the request is aborted; a stub that
    // did not would leave `reader.read()` pending forever and turn every abort
    // test into a hang instead of a cancellation.
    const signal = init?.signal;
    if (signal !== undefined) {
      if (signal.aborted) stream.fail(abortError());
      else signal.addEventListener('abort', () => stream.fail(abortError()), { once: true });
    }
    return Promise.resolve(new Response(stream.body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
  };

  return { fetchImpl, requests, streams };
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Wait until `predicate` holds, so a test never races the pump's own timers. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let queued microtasks and immediates run. */
export async function settle(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

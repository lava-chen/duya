import { describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { HostSessionHttpError } from '@duya/host/http-client';
import { watchRunEventsWithResume } from '../tui/run-event-resume.js';

type Source = Parameters<typeof watchRunEventsWithResume>[0];

function envelope(seq: number, payload: RunEvent): RunEventEnvelope {
  return {
    sessionId: 'session-1',
    runId: 'run-1',
    seq,
    timestamp: 1_760_000_000_000,
    traceId: 'trace-1',
    payload,
  };
}

function text(seq: number, value: string): RunEventEnvelope {
  return envelope(seq, { type: 'assistant.text_block', text: value, messageId: 'm-1', index: 0 });
}

const completed = (seq: number): RunEventEnvelope =>
  envelope(seq, { type: 'run.completed', status: 'completed' });

async function* streamOf(...events: RunEventEnvelope[]): AsyncGenerator<RunEventEnvelope> {
  for (const event of events) yield event;
}

async function* streamThenFail(
  events: readonly RunEventEnvelope[],
  error: Error,
): AsyncGenerator<RunEventEnvelope> {
  for (const event of events) yield event;
  throw error;
}

function source(overrides: Partial<Record<keyof Source, unknown>>): Source {
  return {
    watchAgentRunEvents: vi.fn(),
    getAgentRun: vi.fn(),
    readAgentRunEvents: vi.fn(),
    ...overrides,
  } as unknown as Source;
}

async function collect(iterable: AsyncIterable<RunEventEnvelope>): Promise<number[]> {
  const seen: number[] = [];
  for await (const event of iterable) seen.push(event.seq);
  return seen;
}

describe('watchRunEventsWithResume', () => {
  it('resubscribes from the last accepted seq after a transport drop', async () => {
    const watch = vi.fn()
      .mockImplementationOnce(() => streamThenFail([text(1, 'a'), text(2, 'b')], new TypeError('terminated')))
      .mockImplementationOnce(() => streamOf(text(3, 'c'), completed(4)));
    const read = vi.fn();
    const onRecovering = vi.fn();
    const onRecovered = vi.fn();

    const seen = await collect(watchRunEventsWithResume(
      source({ watchAgentRunEvents: watch, getAgentRun: vi.fn(async () => ({ terminal: null })), readAgentRunEvents: read }),
      'run-1',
      { retryDelaysMs: [0], onRecovering, onRecovered },
    ));

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(watch).toHaveBeenCalledTimes(2);
    expect(watch.mock.calls[1]![1]).toMatchObject({ afterSeq: 2 });
    expect(read).not.toHaveBeenCalled();
    expect(onRecovering).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('replays the durable tail when the run settled while the stream was down', async () => {
    const watch = vi.fn()
      .mockImplementationOnce(() => streamThenFail([text(1, 'a')], new TypeError('terminated')));
    const read = vi.fn(async () => [text(2, 'b'), completed(3)]);

    const seen = await collect(watchRunEventsWithResume(
      source({
        watchAgentRunEvents: watch,
        getAgentRun: vi.fn(async () => ({ terminal: 'completed' })),
        readAgentRunEvents: read,
      }),
      'run-1',
      { retryDelaysMs: [0] },
    ));

    expect(seen).toEqual([1, 2, 3]);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('run-1', { afterSeq: 1, limit: 500 });
  });

  it('pages through a long durable tail', async () => {
    const watch = vi.fn()
      .mockImplementationOnce(() => streamThenFail([text(1, 'a')], new TypeError('terminated')));
    const pages = [
      Array.from({ length: 500 }, (_, index) => text(index + 2, 'x')),
      [completed(502)],
    ];
    const read = vi.fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1]);

    const seen = await collect(watchRunEventsWithResume(
      source({
        watchAgentRunEvents: watch,
        getAgentRun: vi.fn(async () => ({ terminal: 'completed' })),
        readAgentRunEvents: read,
      }),
      'run-1',
      { retryDelaysMs: [0] },
    ));

    expect(seen).toHaveLength(502);
    expect(seen.at(-1)).toBe(502);
    expect(read.mock.calls[1]![1]).toMatchObject({ afterSeq: 501 });
  });

  it('gives up on a run the Host says no longer exists', async () => {
    const watch = vi.fn()
      .mockImplementationOnce(() => streamThenFail([], new TypeError('terminated')));
    const getRun = vi.fn(async () => null);

    await expect(collect(watchRunEventsWithResume(
      source({ watchAgentRunEvents: watch, getAgentRun: getRun }),
      'run-1',
      { retryDelaysMs: [0] },
    ))).rejects.toThrow('terminated');
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refusal that cannot change', async () => {
    const watch = vi.fn(() => {
      throw new HostSessionHttpError(404, 'run_not_found');
    });
    const getRun = vi.fn();

    await expect(collect(watchRunEventsWithResume(
      source({ watchAgentRunEvents: watch, getAgentRun: getRun }),
      'run-1',
      { retryDelaysMs: [0] },
    ))).rejects.toThrow('run_not_found');
    expect(getRun).not.toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('throws the original error once the retry budget is spent', async () => {
    const watch = vi.fn()
      .mockImplementation(() => streamThenFail([], new TypeError('fetch failed')));
    const getRun = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(collect(watchRunEventsWithResume(
      source({ watchAgentRunEvents: watch, getAgentRun: getRun }),
      'run-1',
      { retryDelaysMs: [0, 0] },
    ))).rejects.toThrow('fetch failed');
    expect(getRun).toHaveBeenCalledTimes(2);
    expect(watch).toHaveBeenCalledTimes(1);
  });
});

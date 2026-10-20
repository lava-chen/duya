import { describe, expect, it } from 'vitest';
import { createWebUiServices } from '../../src/client/ui-services-adapter.js';
import { frameFor, messageFinalized, runCompleted, runStarted, RUN_ID, SESSION_ID, StubStream, textDelta, turnCompleted, turnStarted, waitFor } from './fixtures.js';
import { createStubBff } from './stub-bff.js';

const runningRun = {
  runId: RUN_ID,
  sessionId: SESSION_ID,
  status: 'running' as const,
  createdAt: 1,
};

function tail(): string {
  return [
    runStarted(1),
    turnStarted(2),
    textDelta(3, 'assistant-1', 'final answer'),
    messageFinalized(4, 'assistant-1', 'final answer'),
    turnCompleted(5),
    runCompleted(6),
  ].map(frameFor).join('');
}

describe('Web UiServices RunSession lifecycle', () => {
  it('keeps replay open after terminal ledger state until the final SSE tail drains', async () => {
    const streams: StubStream[] = [];
    const streamSignals: AbortSignal[] = [];
    const bff = createStubBff({
      runs: { [SESSION_ID]: [runningRun] },
      overrides: {
        [`/api/runs/${RUN_ID}/events`]: async (_url, init) => {
          if (init?.signal !== undefined) streamSignals.push(init.signal);
          const stream = new StubStream();
          streams.push(stream);
          return new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
      },
    });
    const services = createWebUiServices({ fetchImpl: bff.fetchImpl, runLedgerPollIntervalMs: 5, reconnectDelayMs: 5, stallTimeoutMs: 0 });
    const scope = new AbortController();
    const run = services.runs.openSession(RUN_ID, SESSION_ID, scope.signal);
    run.start();
    await waitFor(() => streams.length === 1);

    bff.setRuns(SESSION_ID, [{ ...runningRun, status: 'completed' }]);
    await waitFor(() => run.getDurableStatus() === 'completed');
    expect(streamSignals[0]?.aborted).toBe(false);

    streams[0]?.push(tail());
    await waitFor(() => run.getSnapshot().lastAcceptedSeq === 6);
    streams[0]?.close();
    await run.settled();

    expect(streamSignals[0]?.aborted).toBe(true);
    expect(run.getDurableStatus()).toBe('completed');
    expect(run.getSnapshot().messages[0]?.text).toBe('final answer');
    expect(run.getSnapshot().run.status).toBe('completed');
  });

  it('reconnects after an early clean EOF and stops only on a replay EOF after terminal status', async () => {
    const streams: StubStream[] = [];
    const bff = createStubBff({
      runs: { [SESSION_ID]: [runningRun] },
      overrides: {
        [`/api/runs/${RUN_ID}/events`]: async () => {
          const stream = new StubStream();
          streams.push(stream);
          if (streams.length === 1) stream.close();
          return new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
      },
    });
    const services = createWebUiServices({ fetchImpl: bff.fetchImpl, runLedgerPollIntervalMs: 5, reconnectDelayMs: 5, stallTimeoutMs: 0 });
    const scope = new AbortController();
    const run = services.runs.openSession(RUN_ID, SESSION_ID, scope.signal);
    run.start();
    await waitFor(() => streams.length === 2);

    const priorLedgerReads = bff.calls.filter((call) => call.path === `/api/sessions/${SESSION_ID}/runs`).length;
    bff.setRuns(SESSION_ID, [{ ...runningRun, status: 'failed' }]);
    await waitFor(() => bff.calls.filter((call) => call.path === `/api/sessions/${SESSION_ID}/runs`).length > priorLedgerReads);
    await waitFor(() => run.getDurableStatus() === 'failed');
    expect(scope.signal.aborted).toBe(false);
    expect(streams).toHaveLength(2);

    streams[1]?.push(tail());
    await waitFor(() => run.getSnapshot().lastAcceptedSeq === 6);
    streams[1]?.close();
    await run.settled();

    expect(run.getDurableStatus()).toBe('failed');
    expect(run.getSnapshot().messages[0]?.text).toBe('final answer');
    expect(streams).toHaveLength(2);
  });
});

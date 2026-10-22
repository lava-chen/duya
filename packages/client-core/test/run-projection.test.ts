import { describe, expect, it, vi } from 'vitest';
import type { AgentRunRecord } from '@duya/agent-protocol';
import { createRunProjection } from '../src/session/run-projection.js';
import type { HostApiBridge } from '../src/transport/host-api.js';

/**
 * A bridge whose only interesting method is the one a test names.
 *
 * Everything else refuses, so a test that accidentally reaches an
 * unimplemented operation fails loudly instead of resolving `undefined` and
 * quietly satisfying an assertion.
 */
function createStubBridge(overrides: Partial<HostApiBridge>): HostApiBridge {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`bridge.${name} was not expected to be called`);
  };
  return {
    listSessions: refuse('listSessions'),
    getSession: refuse('getSession'),
    createSession: refuse('createSession'),
    updateSession: refuse('updateSession'),
    deleteSession: refuse('deleteSession'),
    readMessages: refuse('readMessages'),
    listRuns: refuse('listRuns'),
    startRun: refuse('startRun'),
    cancelRun: refuse('cancelRun'),
    readRunEvents: refuse('readRunEvents'),
    listPendingApprovals: refuse('listPendingApprovals'),
    resolveApproval: refuse('resolveApproval'),
    ...overrides,
  };
}

function runRow(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    manifest: {} as AgentRunRecord['manifest'],
    manifestHash: 'hash-1',
    inputHash: null,
    status: 'running',
    terminal: null,
    metrics: null,
    origin: null,
    parentRunId: null,
    createdAt: 1_000,
    startedAt: 1_010,
    finishedAt: null,
    ...overrides,
  };
}

describe('createRunProjection', () => {
  it('reports the durable status without inventing it', async () => {
    // The status comes from the Host's ledger, and only from there. A client
    // that inferred "the run finished" from a quiet stream would show a
    // completed answer for a turn that never ran.
    const listRuns = vi.fn(async () => [runRow({ status: 'completed' })]);
    const projection = createRunProjection({
      bridge: createStubBridge({ listRuns }),
      runId: 'run-1',
      sessionId: 'session-1',
      signal: new AbortController().signal,
      ledgerPollIntervalMs: 5,
    });

    expect(projection.getDurableStatus()).toBeNull();
    projection.start();
    await vi.waitFor(() => expect(projection.getDurableStatus()).toBe('completed'));
    projection.stop();
    await projection.settled();
  });

  it('keeps the previous status when a ledger read fails', async () => {
    // A transient Host hiccup must not turn a running run into a failed one.
    let reads = 0;
    const listRuns = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return [runRow({ status: 'running' })];
      throw new Error('host is briefly unavailable');
    });
    const projection = createRunProjection({
      bridge: createStubBridge({ listRuns }),
      runId: 'run-1',
      sessionId: 'session-1',
      signal: new AbortController().signal,
      ledgerPollIntervalMs: 5,
    });

    projection.start();
    await vi.waitFor(() => expect(projection.getDurableStatus()).toBe('running'));
    // The failed read leaves the reported status where it was.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(projection.getDurableStatus()).toBe('running');
    projection.stop();
    await projection.settled();
  });

  it('falls back to durable windows when the bridge cannot stream', async () => {
    // A bridge with no `openRunStream` still produces the same projection:
    // the cursor is the surface's own, so a window is never re-applied and
    // never skipped. It is only slower, because the client asks.
    const readRunEvents = vi.fn(async () => []);
    const listRuns = vi.fn(async () => [runRow({ status: 'running' })]);
    const projection = createRunProjection({
      bridge: createStubBridge({ readRunEvents, listRuns }),
      runId: 'run-1',
      sessionId: 'session-1',
      signal: new AbortController().signal,
      ledgerPollIntervalMs: 5,
      fallbackPollIntervalMs: 5,
    });

    projection.start();
    await vi.waitFor(() => expect(readRunEvents).toHaveBeenCalled());
    // The fallback asks from the surface's own cursor.
    expect(readRunEvents.mock.calls[0]?.[1]).toBe(0);
    projection.stop();
    await projection.settled();
  });

  it('keeps the stream open until the ledger confirms the terminal state', async () => {
    // The tempting shortcut is to treat the stream's end as the run's end. It
    // is wrong in a way users see: a dropped socket, a cancelled worker and a
    // Host restart all look like "the stream stopped", and a client that
    // reads that as "the run finished" shows a completed answer for a turn
    // that never ran.
    //
    // So the stream's clean EOF closes the projection ONLY after the ledger
    // has reported a terminal status. The two halves are separate facts and
    // the test separates them too.
    let ledgerStatus: AgentRunRecord['status'] = 'running';
    const listRuns = vi.fn(async () => [runRow({ status: ledgerStatus })]);
    const encoder = new TextEncoder();
    let closeFirst: (() => void) | null = null;
    let streamsOpened = 0;
    const openRunStream = vi.fn(async () => {
      streamsOpened += 1;
      const first = streamsOpened === 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          if (first) {
            closeFirst = () => controller.close();
          } else {
            // Every later attempt ends immediately, so the projection keeps
            // seeing clean EOFs while it waits for the ledger.
            controller.close();
          }
        },
      });
      return body;
    });
    const projection = createRunProjection({
      bridge: createStubBridge({ listRuns, openRunStream }),
      runId: 'run-1',
      sessionId: 'session-1',
      signal: new AbortController().signal,
      ledgerPollIntervalMs: 5,
      reconnectDelayMs: 5,
    });

    projection.start();
    await vi.waitFor(() => expect(openRunStream).toHaveBeenCalled());
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalled());

    // The stream ends while the ledger still says "running".
    closeFirst?.();
    await vi.waitFor(() => expect(streamsOpened).toBeGreaterThan(1));
    // The projection did NOT treat the EOF as the run's end: it reconnected,
    // because only the ledger may say a run finished.
    expect(projection.getDurableStatus()).toBe('running');

    // Now the ledger confirms it. The next clean EOF may close the projection.
    ledgerStatus = 'completed';
    await vi.waitFor(() => expect(projection.getDurableStatus()).toBe('completed'));
    const settled = await Promise.race([
      projection.settled().then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    // A terminal ledger row plus a clean EOF ends the projection. Without the
    // terminal fact, the projection would keep reconnecting forever.
    expect(settled).toBe('settled');
  });

  it('stops everything when the selection scope is aborted', async () => {
    const scope = new AbortController();
    const listRuns = vi.fn(async () => [runRow()]);
    const projection = createRunProjection({
      bridge: createStubBridge({ listRuns }),
      runId: 'run-1',
      sessionId: 'session-1',
      signal: scope.signal,
      ledgerPollIntervalMs: 5,
    });

    projection.start();
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalled());
    const callsBeforeAbort = listRuns.mock.calls.length;
    scope.abort();
    await projection.settled();

    // The scope is a selection: once it is gone, nothing may keep writing
    // into the selection that no longer exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listRuns.mock.calls.length).toBe(callsBeforeAbort);
  });
});

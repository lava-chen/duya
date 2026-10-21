/**
 * Workspace store tests.
 *
 * The subject here is the store's own contract, which is mostly about what it
 * REFUSES to do:
 *
 *  - a selection response that lands after the user has already moved on must
 *    not overwrite the new selection;
 *  - the previous selection's reads and stream must actually stop;
 *  - an accepted cancellation request is not a finished cancellation, and only
 *    the durable ledger may say the run ended;
 *  - an approval decision goes to the permission ledger, on the worker's own
 *    path, with the CSRF token the server handed out.
 */

import { describe, expect, it } from 'vitest';
import { Workspace, pickRun } from '../../src/client/workspace.js';
import { createStubBff, type StubRun } from './stub-bff.js';
import type { RunEventEnvelope, RunId, SessionId } from '@duya/agent-protocol';

const IDLE_POLL = 60_000;

function runningRun(sessionId: string, runId = 'run-a'): StubRun {
  return { runId, sessionId, status: 'running', createdAt: 1_700_000_000_000 };
}

function workspaceFor(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): Workspace {
  return new Workspace({ fetchImpl, pollIntervalMs: IDLE_POLL, cancelPollIntervalMs: 20, reconnectDelayMs: 5 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('pickRun', () => {
  it('opens the live run rather than the newest finished one', () => {
    const finished = { runId: 'r1', sessionId: 's', status: 'completed' as const, createdAt: 10 };
    const live = { runId: 'r2', sessionId: 's', status: 'running' as const, createdAt: 5 };

    expect(pickRun([finished, live])?.runId).toBe('r2');
  });

  it('falls back to the newest run when every run has settled', () => {
    const older = { runId: 'r1', sessionId: 's', status: 'completed' as const, createdAt: 10 };
    const newer = { runId: 'r2', sessionId: 's', status: 'cancelled' as const, createdAt: 20 };

    expect(pickRun([older, newer])?.runId).toBe('r2');
    expect(pickRun([])).toBeNull();
  });
});

describe('Workspace selection', () => {
  it('ignores a late start response after switching sessions', async () => {
    const pending = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }, { id: 'session-b', title: 'B 会话' }],
      runs: { 'session-a': [], 'session-b': [] },
      overrides: {
        '/api/runs/start': async (_url, init) => {
          requestSignal = init?.signal ?? undefined;
          return await pending.promise;
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');

    const send = workspace.send('你好');
    await settle();
    await workspace.select('session-b');
    pending.resolve(new Response(JSON.stringify({ accepted: true, stage: 'dispatched', runId: 'run-late' }), { status: 202 }));
    await send;

    expect(requestSignal?.aborted).toBe(true);
    expect(workspace.getSnapshot().selectedSessionId).toBe('session-b');
    expect(workspace.getSnapshot().runId).toBeNull();
    expect(workspace.getSnapshot().sending).toBe(false);
    workspace.stop();
  });

  it('aborts all initial reads when the selection changes', async () => {
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }, { id: 'session-b', title: 'B 会话' }],
      runs: { 'session-a': [runningRun('session-a')], 'session-b': [] },
    });
    const selectionRequests: { path: string; signal: AbortSignal }[] = [];
    const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
      const path = new URL(input, 'http://stub.local').pathname;
      if (init?.signal !== undefined && [
        '/api/sessions',
        '/api/sessions/session-a/messages',
        '/api/sessions/session-a/runs',
      ].includes(path)) selectionRequests.push({ path, signal: init.signal });
      return bff.fetchImpl(input, init);
    };
    const workspace = workspaceFor(fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    await workspace.select('session-b');
    workspace.stop();

    expect(selectionRequests.map(({ path }) => path).sort()).toEqual([
      '/api/sessions',
      '/api/sessions',
      '/api/sessions/session-a/messages',
      '/api/sessions/session-a/runs',
      '/api/sessions/session-a/runs',
    ]);
    expect(selectionRequests.every(({ signal }) => signal.aborted)).toBe(true);
  });

  it('loads every durable history page for the selected session', async () => {
    const pageRequests: string[] = [];
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }],
      runs: { 'session-a': [] },
      overrides: {
        '/api/sessions/session-a/messages': async (url) => {
          const cursor = url.searchParams.get('cursor');
          pageRequests.push(cursor ?? 'first');
          const id = cursor === null ? 'm-old' : 'm-new';
          return new Response(JSON.stringify({
            sessionId: 'session-a',
            messages: [{
              id,
              sequence: cursor === null ? 1 : 2,
              createdAt: cursor === null ? 1 : 2,
              turnId: null,
              entry: {
                type: 'message',
                id,
                parentId: null,
                createdAt: cursor === null ? 1 : 2,
                message: { role: 'user', content: id },
              },
            }],
            nextCursor: cursor === null ? 'page-2' : null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');

    expect(pageRequests).toEqual(['first', 'page-2']);
    expect(workspace.getSnapshot().messages.map((message) => message.id)).toEqual(['m-old', 'm-new']);
    workspace.stop();
  });

  it('drains a terminal run replay before stopping its stream', async () => {
    const abortSignals: AbortSignal[] = [];
    const runId = 'run-a' as RunId;
    const sessionId = 'session-a' as SessionId;
    const started: RunEventEnvelope = {
      runId,
      sessionId,
      seq: 1,
      timestamp: 1,
      traceId: 'trace-a',
      payload: { type: 'run.started', manifestHash: 'hash', protocol: { major: 1, minor: 0 }, runtime: { name: 'test', version: '1' } },
    };
    const tool: RunEventEnvelope = {
      runId,
      sessionId,
      seq: 2,
      timestamp: 2,
      traceId: 'trace-a',
      payload: { type: 'tool.call_started', toolCallId: 'tool-a', toolName: 'read_file', arguments: { path: 'README.md' }, attempt: 1 },
    };
    const terminal: RunEventEnvelope = {
      runId,
      sessionId,
      seq: 3,
      timestamp: 3,
      traceId: 'trace-a',
      payload: { type: 'run.completed', status: 'completed' },
    };
    const frame = (event: RunEventEnvelope): string => `id: ${event.seq}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`;
    const bff = createStubBff({
      sessions: [{ id: sessionId, title: 'A 会话' }],
      runs: { [sessionId]: [{ ...runningRun(sessionId, runId), status: 'completed' }] },
      overrides: {
        [`/api/runs/${runId}/events`]: async (_url, init) => {
          if (init?.signal !== undefined) abortSignals.push(init.signal);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode([started, tool, terminal].map(frame).join('')));
                controller.close();
              }, 25);
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select(sessionId);

    for (let index = 0; index < 20 && workspace.getSnapshot().snapshot?.lastAcceptedSeq !== 3; index += 1) await settle(1);
    expect(workspace.getSnapshot().snapshot?.lastAcceptedSeq).toBe(3);
    expect(workspace.getSnapshot().snapshot?.toolCalls).toHaveLength(1);
    expect(abortSignals[0]?.aborted).toBe(true);
    workspace.stop();
  });

  it('drops a selection response that arrives after the user switched away', async () => {
    const slow = deferred<Response>();
    let released = false;
    const bff = createStubBff({
      sessions: [
        { id: 'session-a', title: 'A 会话', recencyAt: 20 },
        { id: 'session-b', title: 'B 会话', recencyAt: 30 },
      ],
      messages: {
        'session-b': [{ id: 'm-b', turnId: 'turn-b', role: 'user', text: 'B 的消息', createdAt: 1_700_000_000_000 }],
      },
      runs: {},
      overrides: {
        // A's message page is still in flight when the user clicks B.
        '/api/sessions/session-a/messages': async () => {
          await slow.promise;
          released = true;
          return new Response(JSON.stringify({
            sessionId: 'session-a',
            messages: [{
              id: 'm-a',
              sequence: 1,
              createdAt: 1_700_000_000_000,
              turnId: null,
              entry: {
                type: 'message',
                id: 'm-a',
                parentId: null,
                createdAt: 1_700_000_000_000,
                message: { role: 'user', content: 'A 的消息' },
              },
            }],
            nextCursor: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();

    const first = workspace.select('session-a');
    await settle();
    await workspace.select('session-b');
    slow.resolve(new Response('{}', { status: 500 }));
    await first;
    await settle();

    const state = workspace.getSnapshot();
    expect(released).toBe(true);
    expect(state.selectedSessionId).toBe('session-b');
    expect(state.selectedSession?.title).toBe('B 会话');
    expect(state.messages.map((message) => message.text)).toEqual(['B 的消息']);

    workspace.stop();
  });

  it('aborts the previous selection and stops its run stream', async () => {
    const aborted: string[] = [];
    const bff = createStubBff({
      sessions: [
        { id: 'session-a', title: 'A 会话' },
        { id: 'session-b', title: 'B 会话' },
      ],
      runs: {
        'session-a': [runningRun('session-a', 'run-a')],
        'session-b': [],
      },
      overrides: {
        '/api/runs/run-a/events': async (_url, init) => {
          init?.signal?.addEventListener('abort', () => aborted.push('run-a'), { once: true });
          return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    await settle();
    expect(workspace.getSnapshot().runId).toBe('run-a');

    await workspace.select('session-b');
    await settle();

    expect(aborted).toContain('run-a');
    expect(workspace.getSnapshot().runId).toBeNull();
    expect(workspace.getSnapshot().snapshot).toBeNull();
    expect(workspace.getSnapshot().selectedSessionId).toBe('session-b');

    workspace.stop();
  });

  it('reports an empty workspace honestly instead of inventing a session', async () => {
    const bff = createStubBff({ sessions: [], runs: {} });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();

    const state = workspace.getSnapshot();
    expect(state.phase).toBe('ready');
    expect(state.sessions).toEqual([]);
    expect(state.selectedSessionId).toBeNull();

    workspace.stop();
  });

  it('surfaces a refused start with the Host reason attached', async () => {
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }],
      runs: { 'session-a': [] },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    bff.setStartOutcome({ accepted: false, reason: 'no_provider' });

    await workspace.send('你好');

    const state = workspace.getSnapshot();
    expect(state.sending).toBe(false);
    expect(state.sendError).toContain('start_refused');
    expect(state.runId).toBeNull();

    workspace.stop();
  });
});

describe('Workspace cancellation', () => {
  it('ignores late cancel and approval responses after switching sessions', async () => {
    const pendingCancel = deferred<Response>();
    const pendingApproval = deferred<Response>();
    let cancelSignal: AbortSignal | undefined;
    let approvalSignal: AbortSignal | undefined;
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }, { id: 'session-b', title: 'B 会话' }],
      runs: { 'session-a': [runningRun('session-a', 'run-a')], 'session-b': [] },
      approvals: {
        'session-a': [{ id: 'perm-a', sessionId: 'session-a', toolName: 'write_file', toolInput: {}, status: 'pending', createdAt: 1 }],
      },
      overrides: {
        '/api/runs/run-a/events': async (_url, init) => new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              controller.error(error);
            }, { once: true });
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        '/api/runs/run-a/cancel': async (_url, init) => {
          cancelSignal = init?.signal ?? undefined;
          return await pendingCancel.promise;
        },
        '/api/approvals/perm-a/resolve': async (_url, init) => {
          approvalSignal = init?.signal ?? undefined;
          return await pendingApproval.promise;
        },
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');

    const cancel = workspace.cancelSelectedRun();
    await settle();
    await workspace.select('session-b');
    pendingCancel.resolve(new Response(JSON.stringify({ requested: true, runId: 'run-a' }), { status: 200 }));
    await cancel;
    expect(cancelSignal?.aborted).toBe(true);
    expect(workspace.getSnapshot().cancelRequested).toBe(false);
    expect(workspace.getSnapshot().selectedSessionId).toBe('session-b');

    await workspace.select('session-a');
    const approval = workspace.resolveApproval('perm-a', 'allow');
    await settle();
    await workspace.select('session-b');
    pendingApproval.resolve(new Response(JSON.stringify({ result: {
      id: 'perm-a', sessionId: 'session-a', toolName: 'write_file', toolInput: {}, status: 'allow', decision: 'allow',
      createdAt: 1, resolvedAt: 2,
    } }), { status: 200 }));
    await approval;

    expect(approvalSignal?.aborted).toBe(true);
    expect(workspace.getSnapshot().resolvingApprovalId).toBeNull();
    expect(workspace.getSnapshot().approvalError).toBeNull();
    expect(workspace.getSnapshot().selectedSessionId).toBe('session-b');
    workspace.stop();
  });

  it('keeps saying "requested" until the durable ledger reports the run ended', async () => {
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }],
      runs: { 'session-a': [runningRun('session-a', 'run-a')] },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    await settle();

    await workspace.cancelSelectedRun();
    await settle();

    // The Host acknowledged the REQUEST. The run is still running, so the client
    // must not claim it ended.
    let state = workspace.getSnapshot();
    expect(state.cancelRequested).toBe(true);
    expect(state.cancelError).toBeNull();
    expect(state.durableRun?.status).toBe('running');

    // The native cancellation path can end without publishing a terminal event,
    // so only the ledger closes the question. It reports cancelled here.
    bff.setRuns('session-a', [{ ...runningRun('session-a', 'run-a'), status: 'cancelled' }]);
    await workspace.retrySelection();
    await settle();

    state = workspace.getSnapshot();
    expect(state.durableRun?.status).toBe('cancelled');
    expect(state.cancelRequested).toBe(false);

    workspace.stop();
  });

  it('reports a refused cancellation instead of retrying it', async () => {
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }],
      runs: { 'session-a': [runningRun('session-a', 'run-a')] },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    await settle();
    bff.setCancelOutcome({ requested: false, reason: 'run_not_active' });

    await workspace.cancelSelectedRun();
    await settle();

    const state = workspace.getSnapshot();
    expect(state.cancelRequested).toBe(false);
    expect(state.cancelError).toBe('cancel_refused:run_not_active');
    const cancelCalls = bff.calls.filter((call) => call.path === '/api/runs/run-a/cancel');
    expect(cancelCalls).toHaveLength(1);

    workspace.stop();
  });
});

describe('Workspace approvals', () => {
  it('reads the permission ledger and answers it on the worker path with a CSRF token', async () => {
    const bff = createStubBff({
      sessions: [{ id: 'session-a', title: 'A 会话' }],
      runs: { 'session-a': [runningRun('session-a', 'run-a')] },
      approvals: {
        'session-a': [{
          id: 'perm-1',
          sessionId: 'session-a',
          toolName: 'write_file',
          toolInput: { path: 'notes.md' },
          status: 'pending',
          decision: null,
          createdAt: 1_700_000_000_000,
          resolvedAt: null,
        }],
      },
    });
    const workspace = workspaceFor(bff.fetchImpl);
    await workspace.start();
    await workspace.select('session-a');
    await settle();

    expect(workspace.getSnapshot().approvals.map((entry) => entry.id)).toEqual(['perm-1']);

    await workspace.resolveApproval('perm-1', 'allow');
    await settle();

    const state = workspace.getSnapshot();
    expect(state.approvals).toEqual([]);
    const resolveCall = bff.calls.find((call) => call.path === '/api/approvals/perm-1/resolve');
    expect(resolveCall?.method).toBe('POST');
    // The mutation carries the token from GET /api/bootstrap and nothing else.
    expect(resolveCall?.csrf).toBe('stub-csrf-token');

    workspace.stop();
  });
});

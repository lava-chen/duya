/**
 * useSubagentRuntimeStream.test.tsx
 *
 * The hook is the panel's only live data source, so the two things worth
 * proving are (a) it replays + streams the CHILD-keyed buffer and tears the
 * subscription down on unmount, and (b) the stop control reports failure
 * instead of throwing, because a sub-agent that finished between the click and
 * the request is not a user-facing error.
 *
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgressEvent } from '@/lib/stream-session-manager';

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: AgentProgressEvent) => void>(),
  subscribeCalls: [] as string[],
  unsubscribeCount: 0,
  snapshot: { events: [] as AgentProgressEvent[], startedAt: null as number | null, terminalAt: null as number | null },
}));

vi.mock('@/lib/stream-session-manager', () => ({
  streamSessionManager: {
    subscribeToSubagentProgress: (sessionId: string, listener: (event: AgentProgressEvent) => void) => {
      mocks.subscribeCalls.push(sessionId);
      mocks.listeners.add(listener);
      // Mirrors the real manager: retained history is replayed synchronously
      // before the subscription goes live.
      for (const event of mocks.snapshot.events) listener(event);
      return () => {
        mocks.unsubscribeCount += 1;
        mocks.listeners.delete(listener);
      };
    },
    getSubagentProgressSnapshot: () => ({
      events: [...mocks.snapshot.events],
      startedAt: mocks.snapshot.startedAt,
      terminalAt: mocks.snapshot.terminalAt,
    }),
  },
}));

import { killSubagent, useSubagentRuntimeStream } from '../useSubagentRuntimeStream';

function emit(event: AgentProgressEvent): void {
  act(() => {
    mocks.listeners.forEach((listener) => listener(event));
  });
}

describe('useSubagentRuntimeStream', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.subscribeCalls = [];
    mocks.unsubscribeCount = 0;
    mocks.snapshot = { events: [], startedAt: null, terminalAt: null };
  });

  it('does not subscribe without a child session id', () => {
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: '' }));
    expect(mocks.subscribeCalls).toEqual([]);
    expect(result.current.hasLiveStream).toBe(false);
    expect(result.current.hasRuntimeData).toBe(false);
    expect(result.current.status).toBe('pending');
  });

  it('subscribes by CHILD session id and reports no data before the first event', () => {
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));
    expect(mocks.subscribeCalls).toEqual(['child-1']);
    expect(result.current.hasRuntimeData).toBe(false);
    expect(result.current.isStreaming).toBe(false);
  });

  it('projects streamed events into a live transcript and counters', () => {
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));

    emit({ type: 'started', receivedAt: 1_000, sessionId: 'child-1' });
    emit({ type: 'text', data: 'Hel', receivedAt: 1_010, sessionId: 'child-1' });
    emit({ type: 'text', data: 'lo', receivedAt: 1_020, sessionId: 'child-1' });

    expect(result.current.status).toBe('running');
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.hasRuntimeData).toBe(true);
    expect(result.current.startedAt).toBe(1_000);
    expect(result.current.liveMessages).toHaveLength(1);
    expect(String(result.current.liveMessages[0].content)).toBe('Hello');
  });

  it('freezes the duration at the terminal event and reports killed distinctly', () => {
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));

    emit({ type: 'started', receivedAt: 1_000, sessionId: 'child-1' });
    emit({ type: 'done', data: 'killed: user_kill', receivedAt: 4_000, sessionId: 'child-1' });

    expect(result.current.status).toBe('killed');
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.terminalAt).toBe(4_000);
    expect(result.current.durationMs).toBe(3_000);
  });

  it('counts tool invocations by category', () => {
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));
    emit({ type: 'tool_use', toolName: 'read', receivedAt: 1_000, sessionId: 'child-1' });
    emit({ type: 'tool_result', toolName: 'read', toolResult: 'ok', receivedAt: 1_010, sessionId: 'child-1' });
    emit({ type: 'tool_use', toolName: 'bash', receivedAt: 1_020, sessionId: 'child-1' });

    expect(result.current.toolCounts.read).toBe(1);
    expect(result.current.toolCounts.shell).toBe(1);
    expect(result.current.toolCounts.total).toBe(2);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));
    unmount();
    expect(mocks.unsubscribeCount).toBe(1);
    expect(mocks.listeners.size).toBe(0);
  });

  it('re-subscribes when the child session changes and does not mix the logs', () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSubagentRuntimeStream({ subAgentSessionId: id }),
      { initialProps: { id: 'child-1' } },
    );
    emit({ type: 'text', data: 'first', receivedAt: 1_000, sessionId: 'child-1' });
    expect(String(result.current.liveMessages[0].content)).toBe('first');

    rerender({ id: 'child-2' });
    expect(mocks.subscribeCalls).toEqual(['child-1', 'child-2']);
    expect(result.current.liveMessages).toHaveLength(0);
    expect(result.current.hasRuntimeData).toBe(false);
  });

  it('uses the manager snapshot for timing when the log has no started event', () => {
    mocks.snapshot = { events: [], startedAt: 777, terminalAt: null };
    const { result } = renderHook(() => useSubagentRuntimeStream({ subAgentSessionId: 'child-1' }));
    // No events yet, so the projector has nothing to derive from, but the
    // manager's own clock still gives the header a start reference.
    expect(result.current.startedAt).toBe(777);
  });
});

describe('killSubagent', () => {
  const originalFetch = globalThis.fetch;
  const originalApi = (window as unknown as { electronAPI?: unknown }).electronAPI;

  beforeEach(() => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      getAgentServerPort: vi.fn(async () => 4321),
    };
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (window as unknown as { electronAPI?: unknown }).electronAPI = originalApi;
  });

  it('POSTs taskId to the parent session kill endpoint', async () => {
    const outcome = await killSubagent('parent-1', 'task-9');
    expect(outcome.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/sessions/parent-1/subagents/kill',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ taskId: 'task-9' }) }),
    );
  });

  it('reports a non-2xx response as a non-fatal failure', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch;
    const outcome = await killSubagent('parent-1', 'task-9');
    expect(outcome).toEqual({ ok: false, reason: 'http-404' });
  });

  it('never throws when the request cannot be made', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const outcome = await killSubagent('parent-1', 'task-9');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('ECONNREFUSED');
  });

  it('rejects missing ids without touching the network', async () => {
    const outcome = await killSubagent('', 'task-9');
    expect(outcome).toEqual({ ok: false, reason: 'missing-ids' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

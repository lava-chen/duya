// @vitest-environment jsdom
/**
 * useBotDirectTranscript — Plan 489 P0.3 unit tests
 *
 * Verifies:
 *   - hook calls the full-transcript IPC on mount with the active sessionId
 *   - hook projects `messages` to source-filtered ({send_message, user});
 *     tool_use / thinking / scratchpad / system rows are discarded from the
 *     display list even when the broadcast carries them
 *   - hook exposes `usageMessages` = the FULL transcript so the context-usage
 *     ring can scan token-usage anchors that live on bot-private scratchpad
 *     rows (Plan 489 P0.4)
 *   - session switch resets the hook state
 *   - hook stays inert when window.electronAPI is absent (web / tests)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getBySession: vi.fn(),
  onMessageNewHandler: null as null | ((payload: {
    sessionId: string;
    messages: unknown[];
  }) => void),
}));

vi.mock('@/lib/ipc-client', async (importOriginal) => ({
  // Keep the real module: the realtime merge converts broadcast rows via
  // the actual dbMessageToMessage (snake_case MessageRow → camel IpcMessage).
  ...(await importOriginal<typeof import('@/lib/ipc-client')>()),
  getMessagesBySessionIPC: (sessionId: string) =>
    mocks.getBySession(sessionId),
}));

// electronAPI is a global; tests that need it must set it up here.
function setElectronApi(
  api: { message?: { getBySession?: unknown }; onMessageNew?: unknown },
) {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}
function clearElectronApi() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

import { useBotDirectTranscript } from '../use-bot-direct-transcript';

beforeEach(() => {
  mocks.getBySession.mockReset();
  mocks.onMessageNewHandler = null;
  clearElectronApi();
});

describe('useBotDirectTranscript', () => {
  it('returns empty state when no sessionId is provided', async () => {
    const { result } = renderHook(() => useBotDirectTranscript(null));
    expect(result.current.messages).toEqual([]);
    expect(result.current.usageMessages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('does nothing when window.electronAPI is absent (web / jsdom)', async () => {
    setElectronApi({});
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    // Give the async refresh callback a tick to settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getBySession).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.usageMessages).toEqual([]);
  });

  it('loads the transcript via IPC on mount', async () => {
    mocks.getBySession.mockResolvedValueOnce([
      {
        id: 'm1',
        role: 'user',
        content: 'hi',
        createdAt: 1,
        source: 'user',
      },
      {
        id: 'm2',
        role: 'assistant',
        content: 'reply',
        createdAt: 2,
        msgType: 'text',
        source: 'send_message',
      },
    ]);
    setElectronApi({
      message: { getBySession: mocks.getBySession },
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getBySession).toHaveBeenCalledWith('bot:test1:abc');
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].timestamp).toBe(1);
    expect(result.current.messages[1].timestamp).toBe(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('projects display messages but keeps the full transcript for the ring', async () => {
    mocks.getBySession.mockResolvedValueOnce([
      // Visible — survives the display projection.
      { id: 'v1', role: 'assistant', content: 'reply', timestamp: 1, source: 'send_message' },
      // Hidden from the user, but must stay in `usageMessages` so the ring
      // finds its token-usage anchors on bot-private scratchpad rows.
      { id: 'h1', role: 'assistant', content: '', msgType: 'tool_use', source: 'tool_use', toolName: 'Read' },
      { id: 'h2', role: 'assistant', content: 'plan', msgType: 'thinking', source: 'thinking' },
      { id: 'h3', role: 'system', content: 'sys', source: 'system' },
      { id: 'h4', role: 'assistant', content: 'scratch', source: 'scratchpad' },
    ]);
    setElectronApi({
      message: { getBySession: mocks.getBySession },
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Display list: only visible sources.
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('v1');
    // Usage source: all rows, including the scratchpad usage anchor.
    expect(result.current.usageMessages).toHaveLength(5);
    expect(result.current.usageMessages.map((m) => m.id)).toEqual([
      'v1', 'h1', 'h2', 'h3', 'h4',
    ]);
  });

  it('captures errors from the IPC into result.error', async () => {
    mocks.getBySession.mockRejectedValueOnce(new Error('boom'));
    setElectronApi({
      message: { getBySession: mocks.getBySession },
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.messages).toEqual([]);
  });

  it('merges incoming rows into the display list and the usage list', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { getBySession: mocks.getBySession },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.getBySession.mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    expect(captured).not.toBeNull();
    act(() => {
      captured!({
        sessionId: 'bot:test1:abc',
        messages: [
          // Real broadcast shape: snake_case MessageRow (db-bridge →
          // newEventToIpcMessage). Visible — appended.
          { id: 'new1', role: 'assistant', content: 'reply', created_at: 3, source: 'send_message' },
          // Hidden from the user, but must feed the ring's usage scan.
          { id: 'sc1', role: 'assistant', content: 'scratch', source: 'scratchpad' },
          { id: 't1', role: 'assistant', content: '', msg_type: 'tool_use', source: 'tool_use', tool_name: 'Read' },
          { id: 'th1', role: 'assistant', content: 'plan', msg_type: 'thinking', source: 'thinking' },
          { id: 's1', role: 'system', content: 'sys', source: 'system' },
        ],
      });
    });
    // Display: only the visible send_message row.
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('new1');
    expect(result.current.messages[0].source).toBe('send_message');
    // The snake_case row must land with a valid numeric timestamp —
    // reading camelCase `createdAt` off the raw row yields undefined and
    // crashed date separators with RangeError: Invalid time value.
    expect(result.current.messages[0].timestamp).toBe(3);
    // Usage: all incoming rows (scratchpad anchor included).
    expect(result.current.usageMessages.map((m) => m.id)).toEqual([
      'new1', 'sc1', 't1', 'th1', 's1',
    ]);
  });

  it('drops incoming rows that belong to a different session', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { getBySession: mocks.getBySession },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.getBySession.mockResolvedValueOnce([]);
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    act(() => {
      captured!({
        sessionId: 'bot:other:def', // different session
        messages: [
          { id: 'x1', role: 'user', content: 'nope', created_at: 9, source: 'user' },
        ],
      });
    });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.usageMessages).toHaveLength(0);
  });

  it('dedupes by id: an already-present row is not appended twice', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { getBySession: mocks.getBySession },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.getBySession.mockResolvedValueOnce([
      { id: 'd1', role: 'user', content: 'hi', createdAt: 1, source: 'user' },
    ]);
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    act(() => {
      captured!({
        sessionId: 'bot:test1:abc',
        messages: [
          { id: 'd1', role: 'user', content: 'hi', created_at: 1, source: 'user' },
          { id: 'd2', role: 'assistant', content: 'reply', created_at: 2, source: 'send_message' },
        ],
      });
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.map((m) => m.id)).toEqual(['d1', 'd2']);
    // Dedupe across both lists: d1 appears once, d2 appended once.
    expect(result.current.usageMessages.map((m) => m.id)).toEqual(['d1', 'd2']);
  });

  it('resets the list when the sessionId changes', async () => {
    setElectronApi({
      message: { getBySession: mocks.getBySession },
    });
    mocks.getBySession.mockImplementation(async (sid: string) =>
      sid === 'bot:test1:abc'
        ? [{ id: 'a', role: 'user', content: 'first', timestamp: 1, source: 'user' }]
        : [{ id: 'b', role: 'user', content: 'second', createdAt: 2, source: 'user' }],
    );
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => useBotDirectTranscript(sid),
      { initialProps: { sid: 'bot:test1:abc' } },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['a']);
    rerender({ sid: 'bot:test1:def' });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['b']);
  });
});
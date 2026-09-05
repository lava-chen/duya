// @vitest-environment jsdom
/**
 * useBotDirectTranscript — Plan 489 P0.3 unit tests
 *
 * Verifies:
 *   - hook calls bot-direct IPC on mount with the active sessionId
 *   - hook merges incoming message:new rows whose source is in
 *     {send_message, user}; tool_use / thinking / scratchpad / system
 *     rows are discarded even when the broadcast carries them
 *   - session switch resets the hook state
 *   - hook stays inert when window.electronAPI is absent (web / tests)
 *
 * The hook's `messagesRef` keeps the dedup-by-id state simple:
 * any incoming row whose `id` is already in the live list is skipped.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Message } from '@/types/message';

const mocks = vi.hoisted(() => ({
  botDirectGetTranscript: vi.fn(),
  onMessageNewHandler: null as null | ((payload: {
    sessionId: string;
    messages: unknown[];
  }) => void),
}));

vi.mock('@/lib/ipc-client', () => ({
  getBotDirectTranscriptIPC: (sessionId: string) =>
    mocks.botDirectGetTranscript(sessionId),
}));

// electronAPI is a global; tests that need it must set it up here.
function setElectronApi(
  api: { message?: { botDirectGetTranscript?: unknown }; onMessageNew?: unknown },
) {
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
}
function clearElectronApi() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

import { useBotDirectTranscript } from '../use-bot-direct-transcript';

beforeEach(() => {
  mocks.botDirectGetTranscript.mockReset();
  mocks.onMessageNewHandler = null;
  clearElectronApi();
});

describe('useBotDirectTranscript', () => {
  it('returns empty state when no sessionId is provided', async () => {
    const { result } = renderHook(() => useBotDirectTranscript(null));
    expect(result.current.messages).toEqual([]);
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
    expect(mocks.botDirectGetTranscript).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
  });

  it('loads the bot-direct transcript via IPC on mount', async () => {
    const fetched: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
        source: 'user',
      } as Message,
      {
        id: 'm2',
        role: 'assistant',
        content: 'reply',
        timestamp: 2,
        msgType: 'text',
        source: 'send_message',
      } as Message,
    ];
    mocks.botDirectGetTranscript.mockResolvedValueOnce({
      messages: fetched,
      parsedDocuments: [],
    });
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.botDirectGetTranscript).toHaveBeenCalledWith('bot:test1:abc');
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('captures errors from the IPC into result.error', async () => {
    mocks.botDirectGetTranscript.mockRejectedValueOnce(new Error('boom'));
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
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

  it('merges incoming send_message rows and ignores tool_use / thinking', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.botDirectGetTranscript.mockResolvedValueOnce({
      messages: [],
      parsedDocuments: [],
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    expect(captured).not.toBeNull();
    act(() => {
      captured!({
        sessionId: 'bot:test1:abc',
        messages: [
          // Visible — appended
          { id: 'new1', role: 'assistant', content: 'reply', timestamp: 3, source: 'send_message' },
          // Hidden — must be discarded
          { id: 't1', role: 'assistant', content: '', msgType: 'tool_use', source: 'tool_use', toolName: 'Read' },
          { id: 'th1', role: 'assistant', content: 'plan', msgType: 'thinking', source: 'thinking' },
          { id: 's1', role: 'system', content: 'sys', source: 'system' },
          { id: 'sc1', role: 'assistant', content: 'scratch', source: 'scratchpad' },
        ],
      });
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe('new1');
    expect(result.current.messages[0].source).toBe('send_message');
  });

  it('drops incoming rows that belong to a different session', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.botDirectGetTranscript.mockResolvedValueOnce({
      messages: [],
      parsedDocuments: [],
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    act(() => {
      captured!({
        sessionId: 'bot:other:def', // different session
        messages: [
          { id: 'x1', role: 'user', content: 'nope', timestamp: 9, source: 'user' },
        ],
      });
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it('dedupes by id: an already-present row is not appended twice', () => {
    let captured: ((payload: { sessionId: string; messages: unknown[] }) => void) | null =
      null;
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
      onMessageNew: (cb: (payload: { sessionId: string; messages: unknown[] }) => void) => {
        captured = cb;
        return () => {};
      },
    });
    mocks.botDirectGetTranscript.mockResolvedValueOnce({
      messages: [
        { id: 'd1', role: 'user', content: 'hi', timestamp: 1, source: 'user' },
      ],
      parsedDocuments: [],
    });
    const { result } = renderHook(() =>
      useBotDirectTranscript('bot:test1:abc'),
    );
    act(() => {
      captured!({
        sessionId: 'bot:test1:abc',
        messages: [
          { id: 'd1', role: 'user', content: 'hi', timestamp: 1, source: 'user' },
          { id: 'd2', role: 'assistant', content: 'reply', timestamp: 2, source: 'send_message' },
        ],
      });
    });
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages.map((m) => m.id)).toEqual(['d1', 'd2']);
  });

  it('resets the list when the sessionId changes', async () => {
    setElectronApi({
      message: { botDirectGetTranscript: mocks.botDirectGetTranscript },
    });
    mocks.botDirectGetTranscript.mockImplementation(async (sid: string) => ({
      messages:
        sid === 'bot:test1:abc'
          ? [{ id: 'a', role: 'user', content: 'first', timestamp: 1, source: 'user' }]
          : [{ id: 'b', role: 'user', content: 'second', timestamp: 2, source: 'user' }],
      parsedDocuments: [],
    }));
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

// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNextStepSuggestions } from '../useNextStepSuggestions';

type NextStepsRequest = (sessionId: string) => Promise<{ success: boolean; suggestions: string[] }>;

function mockApi(request: NextStepsRequest) {
  (window as unknown as { electronAPI: { nextSteps: { request: NextStepsRequest } } }).electronAPI = {
    nextSteps: { request: vi.fn(request) },
  };
}

describe('useNextStepSuggestions', () => {
  beforeEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('does nothing on initial mount while idle', () => {
    const request = vi.fn(async () => ({ success: true, suggestions: ['a'] }));
    mockApi(request);
    const { result } = renderHook(() =>
      useNextStepSuggestions({ sessionId: 's1', isStreaming: false }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(result.current.suggestions).toEqual([]);
  });

  it('fetches suggestions when streaming transitions to idle and stores the reply', async () => {
    const request = vi.fn(async () => ({
      success: true,
      suggestions: ['加个重试', '跑测试', '补文档', '多余的第四条'],
    }));
    mockApi(request);
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useNextStepSuggestions({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    rerender({ isStreaming: false });

    await waitFor(() => expect(result.current.suggestions).toHaveLength(3));
    // Capped at three suggestions.
    expect(result.current.suggestions).toEqual(['加个重试', '跑测试', '补文档']);
    expect(result.current.isLoading).toBe(false);
  });

  it('clears suggestions when a new stream starts', async () => {
    const request = vi.fn(async () => ({ success: true, suggestions: ['a'] }));
    mockApi(request);
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useNextStepSuggestions({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    await waitFor(() => expect(result.current.suggestions).toEqual(['a']));

    rerender({ isStreaming: true });
    expect(result.current.suggestions).toEqual([]);
  });

  it('drops stale results after a session switch', async () => {
    let resolveRequest!: (v: { success: boolean; suggestions: string[] }) => void;
    mockApi(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { result, rerender } = renderHook(
      ({ sessionId, isStreaming }: { sessionId: string; isStreaming: boolean }) =>
        useNextStepSuggestions({ sessionId, isStreaming }),
      { initialProps: { sessionId: 's1', isStreaming: true } },
    );

    rerender({ sessionId: 's1', isStreaming: false });
    await waitFor(() => expect(result.current.isLoading).toBe(true));

    // Switch sessions BEFORE the slow request resolves.
    rerender({ sessionId: 's2', isStreaming: false });
    await act(async () => {
      resolveRequest({ success: true, suggestions: ['stale'] });
    });
    expect(result.current.suggestions).toEqual([]);
  });

  it('dismiss() clears the cards', async () => {
    mockApi(async () => ({ success: true, suggestions: ['a'] }));
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useNextStepSuggestions({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    await waitFor(() => expect(result.current.suggestions).toEqual(['a']));

    act(() => result.current.dismiss());
    expect(result.current.suggestions).toEqual([]);
  });

  it('survives a rejected IPC call with empty suggestions', async () => {
    mockApi(async () => {
      throw new Error('ipc down');
    });
    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useNextStepSuggestions({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );
    rerender({ isStreaming: false });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.suggestions).toEqual([]);
  });
});

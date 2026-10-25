// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTurnSuggestion } from '../useTurnSuggestion';

const readLatestTurnSuggestion = vi.fn();

vi.mock('@/lib/turn-suggestion-client', () => ({
  readLatestTurnSuggestion: (...args: unknown[]) => readLatestTurnSuggestion(...args),
}));

describe('useTurnSuggestion', () => {
  beforeEach(() => {
    readLatestTurnSuggestion.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not read anything before a turn ends', async () => {
    const { result } = renderHook(() => useTurnSuggestion({ sessionId: 's1', isStreaming: false }));

    expect(result.current.suggestion).toBeNull();
    expect(readLatestTurnSuggestion).not.toHaveBeenCalled();
  });

  it('reads the suggestion once the turn ends', async () => {
    readLatestTurnSuggestion.mockImplementation(async () => ({
      id: 'row-1',
      sessionId: 's1',
      turnId: 'turn-1',
      suggestion: '跑一下测试',
      createdAt: Date.now(),
    }));

    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useTurnSuggestion({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    await act(async () => {
      rerender({ isStreaming: false });
    });

    await waitFor(() => expect(result.current.suggestion).toBe('跑一下测试'));
    expect(result.current.isLoading).toBe(false);
  });

  it('ignores a row that belongs to an earlier turn', async () => {
    readLatestTurnSuggestion.mockImplementation(async () => ({
      id: 'row-old',
      sessionId: 's1',
      turnId: 'turn-0',
      suggestion: '上一轮的建议',
      createdAt: Date.now() - 60_000,
    }));

    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useTurnSuggestion({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    await act(async () => {
      rerender({ isStreaming: false });
    });

    await waitFor(() => expect(readLatestTurnSuggestion).toHaveBeenCalled());
    // The row is the previous turn's, so it is not offered and the read
    // continues: the surface is still waiting for THIS turn's row.
    expect(result.current.suggestion).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it('treats an empty suggestion of this turn as no suggestion', async () => {
    readLatestTurnSuggestion.mockImplementation(async () => ({
      id: 'row-empty',
      sessionId: 's1',
      turnId: 'turn-1',
      suggestion: '',
      createdAt: Date.now(),
    }));

    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useTurnSuggestion({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    await act(async () => {
      rerender({ isStreaming: false });
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.suggestion).toBeNull();
  });

  it('clears the suggestion when the next turn starts', async () => {
    readLatestTurnSuggestion.mockImplementation(async () => ({
      id: 'row-1',
      sessionId: 's1',
      turnId: 'turn-1',
      suggestion: '跑一下测试',
      createdAt: Date.now(),
    }));

    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) => useTurnSuggestion({ sessionId: 's1', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    await act(async () => {
      rerender({ isStreaming: false });
    });
    await waitFor(() => expect(result.current.suggestion).toBe('跑一下测试'));

    await act(async () => {
      rerender({ isStreaming: true });
    });

    expect(result.current.suggestion).toBeNull();
  });
});

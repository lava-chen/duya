// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamingEvent } from '@/lib/stream-session-manager';

const mocks = vi.hoisted(() => ({
  listener: undefined as ((events: StreamingEvent[]) => void) | undefined,
  unsubscribe: vi.fn(),
}));

vi.mock('@/lib/stream-session-manager', () => ({
  subscribeToStreamingEvents: vi.fn((_sessionId: string, listener: (events: StreamingEvent[]) => void) => {
    mocks.listener = listener;
    return mocks.unsubscribe;
  }),
}));

import { useStreamingActions } from '../useStreamingActions';

describe('useStreamingActions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listener = undefined;
    mocks.unsubscribe.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders in-place text updates from the same events array', () => {
    const events: StreamingEvent[] = [{ type: 'text', content: 'first', timestamp: 1 }];
    const { result } = renderHook(() => useStreamingActions('session-1'));

    act(() => {
      mocks.listener?.(events);
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toEqual([{ kind: 'text', content: 'first' }]);

    act(() => {
      events[0] = { type: 'text', content: 'first second', timestamp: 1 };
      mocks.listener?.(events);
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toEqual([{ kind: 'text', content: 'first second' }]);
  });

  it('coalesces multiple stream notifications into one frame using the latest content', () => {
    const events: StreamingEvent[] = [{ type: 'thinking', content: 'a', timestamp: 1 }];
    const { result } = renderHook(() => useStreamingActions('session-1'));

    act(() => {
      mocks.listener?.(events);
      events[0] = { type: 'thinking', content: 'abc', timestamp: 1 };
      mocks.listener?.(events);
      vi.advanceTimersByTime(16);
    });

    expect(result.current).toEqual([{ kind: 'thinking', content: 'abc', isStreaming: true }]);
  });
});

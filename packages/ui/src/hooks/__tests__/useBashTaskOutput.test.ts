/**
 * useBashTaskOutput.test.ts — polling + follow semantics of the background
 * bash output viewer (plan 566), mirroring ZCode's useBackgroundBashOutput:
 *   - reads once on mount and once when the task is not running
 *   - polls at ~1s while the task is running
 *   - pause() freezes the displayed output; resume() clears and re-reads
 *   - read failure surfaces a recoverable error string
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBashTaskOutput } from '../useBashTaskOutput';
import type { BashBackgroundTaskSnapshot } from '@/types';

const mocks = vi.hoisted(() => ({
  readOutput: vi.fn(),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ locale: 'en', t: (key: string) => key }),
}));

function task(overrides: Partial<BashBackgroundTaskSnapshot> = {}): BashBackgroundTaskSnapshot {
  return {
    id: 't1',
    pid: 1,
    outputFile: '/tmp/out.log',
    command: 'npm run build',
    status: 'running',
    startTime: 0,
    ...overrides,
  };
}

describe('useBashTaskOutput', () => {
  beforeEach(() => {
    mocks.readOutput.mockReset();
    // Inject on the real jsdom window — replacing it would drop
    // setInterval and the document container renderHook needs.
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { bashTasks: { readOutput: mocks.readOutput } },
    });
  });

  it('reads once for a finished task and stops polling', async () => {
    mocks.readOutput.mockResolvedValue({ ok: true, output: 'done', size: 4, truncated: false });
    const { result } = renderHook(() => useBashTaskOutput(task({ status: 'completed' })));
    await waitFor(() => expect(result.current.output).toBe('done'));
    expect(mocks.readOutput).toHaveBeenCalledTimes(1);
    // No interval was scheduled for a non-running task: wait past the poll
    // cadence and confirm no further reads happen.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(mocks.readOutput).toHaveBeenCalledTimes(1);
  }, 5000);

  it('polls every second while the task is running', async () => {
    vi.useFakeTimers();
    try {
      mocks.readOutput.mockResolvedValue({ ok: true, output: 'x', size: 1, truncated: false });
      renderHook(() => useBashTaskOutput(task()));
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.readOutput).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3500);
      expect(mocks.readOutput).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause freezes the view, resume clears the freeze and re-reads', async () => {
    mocks.readOutput.mockResolvedValue({ ok: true, output: 'first', size: 5, truncated: false });
    const { result } = renderHook(() => useBashTaskOutput(task()));
    await waitFor(() => expect(result.current.output).toBe('first'));
    expect(result.current.following).toBe(true);

    act(() => result.current.pause());
    expect(result.current.following).toBe(false);

    mocks.readOutput.mockResolvedValue({ ok: true, output: 'second', size: 6, truncated: false });
    // A poll lands while paused — the view must stay frozen.
    await waitFor(() => expect(mocks.readOutput).toHaveBeenCalledTimes(2));
    expect(result.current.output).toBe('first');

    act(() => result.current.resume());
    expect(result.current.following).toBe(true);
    await waitFor(() => expect(result.current.output).toBe('second'));
  });

  it('surfaces a recoverable error without throwing', async () => {
    mocks.readOutput.mockResolvedValue({ ok: false, error: 'not found' });
    const { result } = renderHook(() => useBashTaskOutput(task({ status: 'completed' })));
    await waitFor(() => expect(result.current.error).toBe('not found'));
    expect(result.current.output).toBe('');
  });
});

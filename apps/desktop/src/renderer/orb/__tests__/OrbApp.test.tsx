/**
 * OrbApp smoke test — verify 4-state wiring.
 *
 * Plan 453 Task F. Playwright e2e covers real orb behavior.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import { OrbApp } from '../OrbApp';

// Mock electronAPI. The main→orb event mocks capture their callbacks so
// tests can drive state transitions from the main-process side.
const handlers: Record<string, (...args: unknown[]) => void> = {};
const capture =
  (name: string) =>
  (cb: (...args: unknown[]) => void): (() => undefined) => {
    handlers[name] = cb;
    return () => undefined;
  };
const mockOrb = {
  submit: vi.fn().mockResolvedValue({ accepted: true }),
  showInput: vi.fn().mockResolvedValue({ ok: true }),
  insertTab: vi.fn().mockResolvedValue({ ok: true }),
  setPosition: vi.fn().mockResolvedValue({ ok: true }),
  state: vi.fn().mockResolvedValue({ state: 'DORMANT' as const }),
  openResult: vi.fn().mockResolvedValue({ ok: true }),
  chatConfig: vi.fn().mockResolvedValue({ model: 'test-model' }),
  pointer: vi.fn().mockResolvedValue(null),
  collapse: vi.fn().mockResolvedValue({ ok: true }),
  onChunk: vi.fn(() => () => undefined),
  onShowInput: vi.fn(capture('showInput')),
  onShowLoading: vi.fn(capture('showLoading')),
  onUpdateProgress: vi.fn(() => () => undefined),
  onShowResult: vi.fn(capture('showResult')),
  onNotifyResult: vi.fn(capture('notifyResult')),
  onHide: vi.fn(capture('hide')),
  onShowInputWithContext: vi.fn(capture('showInputWithContext')),
  resetConversation: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    orb: mockOrb,
  };
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('OrbApp', () => {
  it('renders OrbBall initially in DORMANT state', () => {
    render(<OrbApp />);
    expect(
      screen.getByLabelText(/Duya Orb.*Shift\+\=/),
    ).toBeInTheDocument();
  });

  it('renders the orb-window wrapper with the current state data attribute', () => {
    render(<OrbApp />);
    const win = document.querySelector('.orb-window');
    expect(win).toBeTruthy();
    expect(win?.getAttribute('data-state')).toBe('DORMANT');
  });

  it('registers all IPC subscriptions on mount', () => {
    render(<OrbApp />);
    expect(mockOrb.onChunk).toHaveBeenCalled();
    expect(mockOrb.onShowInput).toHaveBeenCalled();
    expect(mockOrb.onShowLoading).toHaveBeenCalled();
    expect(mockOrb.onUpdateProgress).toHaveBeenCalled();
    expect(mockOrb.onShowResult).toHaveBeenCalled();
    expect(mockOrb.onHide).toHaveBeenCalled();
    expect(mockOrb.onShowInputWithContext).toHaveBeenCalled();
  });

  it('clicking the ball triggers showInput', () => {
    render(<OrbApp />);
    const ball = screen.getByLabelText(/Duya Orb/);
    fireEvent.click(ball);
    expect(mockOrb.showInput).toHaveBeenCalled();
  });

  it('gracefully renders without electronAPI in dev / SSR', () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = undefined;
    render(<OrbApp />);
    expect(
      screen.getByLabelText(/Duya Orb.*Shift\+\=/),
    ).toBeInTheDocument();
  });

  it('plays the wink moment when a prompt is submitted', () => {
    render(<OrbApp />);
    act(() => {
      handlers.showInput?.();
    });
    const field = screen.getByPlaceholderText('问 Duya 任何事...');
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(mockOrb.submit).toHaveBeenCalledWith('hello', []);
    expect(document.querySelector('[data-moment="wink"]')).toBeTruthy();
  });

  it('sends via the send button, like the app input', () => {
    render(<OrbApp />);
    act(() => {
      handlers.showInput?.();
    });
    const field = screen.getByPlaceholderText('问 Duya 任何事...');
    fireEvent.change(field, { target: { value: 'hello' } });
    fireEvent.click(screen.getByLabelText('Send'));
    expect(mockOrb.submit).toHaveBeenCalledWith('hello', []);
  });

  it('send button does not blur the textarea on mousedown (prevents spurious orb collapse / worker interrupt)', () => {
    render(<OrbApp />);
    act(() => {
      handlers.showInput?.();
    });
    const field = screen.getByPlaceholderText('问 Duya 任何事...');
    fireEvent.change(field, { target: { value: 'hello' } });
    const sendBtn = screen.getByLabelText('Send');
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      sendBtn.dispatchEvent(evt);
    });
    // preventDefault on mousedown keeps the textarea focused, so the main
    // process `blur` guard does not collapse the orb and interrupt the worker.
    expect(evt.defaultPrevented).toBe(true);
  });

  it('shows the real model in the picker pill, never a made-up name', async () => {
    mockOrb.chatConfig.mockResolvedValue({
      model: 'test-model',
      options: [
        { providerId: 'p1', label: 'Test Provider', model: 'test-model' },
        { providerId: 'p1', label: 'Test Provider', model: 'other-model' },
      ],
    });
    render(<OrbApp />);
    act(() => {
      handlers.showInput?.();
    });
    await act(async () => {});
    const pill = screen.getByLabelText('选择模型');
    expect(pill.textContent).toContain('test-model');
    // 打开弹窗应列出可选模型
    fireEvent.click(pill);
    expect(await screen.findByText('other-model')).toBeInTheDocument();
  });

  it('celebrates a long task (≥10s LOADING) with the burst moment on RESULT', () => {
    vi.useFakeTimers();
    try {
      const base = 1_000_000;
      vi.setSystemTime(base);
      render(<OrbApp />);
      act(() => {
        (handlers.showLoading as (p: { stage: string }) => void)({
          stage: 'thinking',
        });
      });
      // 11s in LOADING → past the LONG_TASK_MS celebration threshold.
      vi.setSystemTime(base + 11_000);
      act(() => {
        (
          handlers.showResult as (p: {
            turnId: string;
            text: string;
            finishedAt: string;
          }) => void
        )({ turnId: 't1', text: 'done', finishedAt: '' });
      });
      expect(document.querySelector('[data-moment="burst"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not celebrate short answers', () => {
    vi.useFakeTimers();
    try {
      const base = 1_000_000;
      vi.setSystemTime(base);
      render(<OrbApp />);
      act(() => {
        (handlers.showLoading as (p: { stage: string }) => void)({
          stage: 'thinking',
        });
      });
      vi.setSystemTime(base + 2_000);
      act(() => {
        (
          handlers.showResult as (p: {
            turnId: string;
            text: string;
            finishedAt: string;
          }) => void
        )({ turnId: 't1', text: 'done', finishedAt: '' });
      });
      expect(
        document.querySelector('[data-moment="burst"]'),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays exclaim when the submit is rejected', async () => {
    mockOrb.submit.mockResolvedValueOnce({ accepted: false });
    render(<OrbApp />);
    act(() => {
      handlers.showInput?.();
    });
    const field = screen.getByPlaceholderText('问 Duya 任何事...');
    fireEvent.change(field, { target: { value: 'hi' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await act(async () => {}); // flush the submit promise
    expect(document.querySelector('[data-moment="exclaim"]')).toBeTruthy();
  });

  it('badges the ball when a result arrives while DORMANT and opens it on click', () => {
    render(<OrbApp />);
    act(() => {
      (
        handlers.notifyResult as (p: {
          turnId: string;
          text: string;
          finishedAt: string;
        }) => void
      )({ turnId: 't1', text: 'done', finishedAt: '' });
    });
    expect(document.querySelector('[data-moment="notify"]')).toBeTruthy();
    const ball = screen.getByLabelText(/Duya Orb/);
    fireEvent.click(ball);
    expect(mockOrb.openResult).toHaveBeenCalled();
    expect(mockOrb.showInput).not.toHaveBeenCalled();
  });

  it('converges to the main state while DORMANT (event-loss recovery)', async () => {
    vi.useFakeTimers();
    try {
      render(<OrbApp />);
      // Main entered INPUT but the show-input event was lost.
      mockOrb.state.mockResolvedValue({ state: 'INPUT' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(
        document.querySelector('.orb-window')?.getAttribute('data-state'),
      ).toBe('INPUT');
    } finally {
      vi.useRealTimers();
    }
  });
});
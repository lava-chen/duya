/**
 * OrbApp smoke test — verify 4-state wiring.
 *
 * Plan 453 Task F. Playwright e2e covers real orb behavior.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OrbApp } from '../OrbApp';

// Mock electronAPI.
const mockOrb = {
  submit: vi.fn().mockResolvedValue({ accepted: true }),
  showInput: vi.fn().mockResolvedValue({ ok: true }),
  insertTab: vi.fn().mockResolvedValue({ ok: true }),
  setPosition: vi.fn().mockResolvedValue({ ok: true }),
  state: vi.fn().mockResolvedValue({ state: 'DORMANT' as const }),
  collapse: vi.fn().mockResolvedValue({ ok: true }),
  onChunk: vi.fn(() => () => undefined),
  onShowInput: vi.fn(() => () => undefined),
  onShowLoading: vi.fn(() => () => undefined),
  onUpdateProgress: vi.fn(() => () => undefined),
  onShowResult: vi.fn(() => () => undefined),
  onHide: vi.fn(() => () => undefined),
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
});
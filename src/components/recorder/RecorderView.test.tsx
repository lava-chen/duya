// @vitest-environment jsdom

/**
 * RecorderView.test.tsx — plan 556 Phase 5 UI gate.
 *
 * Drives the view through the real `@/lib/recorder-ipc` wrappers with a
 * stubbed `window.electronAPI.recorder`, so the test exercises the same
 * bridge shape the preload exposes (not a mocked-out module):
 * control strip → session list → timeline → convert → save.
 *
 * Assertions use row textContent rather than `getByText(regex)` — a
 * regex match also hits every ancestor element, which makes those
 * queries ambiguous on a nested timeline.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { RecorderView } from './RecorderView';

import type {
  LoadedRecorderSession,
  RecorderSessionSummary,
  RecorderStatusSnapshot,
} from '@/lib/recorder-types';

const summary: RecorderSessionSummary = {
  sessionId: 'sess-1',
  startedAt: Date.UTC(2026, 8, 21, 10, 0, 0),
  endedAt: Date.UTC(2026, 8, 21, 10, 2, 5),
  eventCount: 3,
  apps: [{ processName: 'chrome', name: 'Chrome', hits: 3 }],
};

const session: LoadedRecorderSession = {
  summary,
  events: [
    { type: 'app_focus', ts: 1, app: { name: 'Chrome', title: 'Invoice', processName: 'chrome', pid: 10 } },
    {
      type: 'click',
      ts: 2,
      app: { name: 'Chrome', title: 'Invoice', processName: 'chrome', pid: 10 },
      click: { x: 120, y: 240, button: 'left', count: 1 },
      element: { source: 'uia-probe', name: 'Submit', controlType: 'Button', automationId: 'btn-submit' },
    },
    {
      type: 'type',
      ts: 3,
      app: { name: 'Chrome', title: 'Invoice', processName: 'chrome', pid: 10 },
      text: '<redacted>',
      element: { source: 'uia-probe', controlType: 'Edit', isPassword: true },
    },
  ],
  dropped: [],
};

const idle: RecorderStatusSnapshot = {
  status: 'idle',
  sessionId: null,
  startedAt: null,
  durationMs: null,
  eventCount: 0,
  degraded: false,
};

const api = {
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  convert: vi.fn(),
  onStatusChanged: vi.fn(),
};

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { recorder: api, workflow: { defs: { create: vi.fn() } } },
});

/** Render + wait for the list, then open the only session. */
async function openSession() {
  render(<RecorderView />);
  await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('button', { name: /recorder\.view/ }));
  return screen.findByTestId('recorder-event-1');
}

beforeEach(() => {
  api.start.mockReset().mockResolvedValue({ ok: true, status: { ...idle, status: 'recording', sessionId: 'sess-2' } });
  api.stop.mockReset().mockResolvedValue({ ok: true, summary });
  api.cancel.mockReset().mockResolvedValue({ ok: true });
  api.status.mockReset().mockResolvedValue(idle);
  api.listSessions.mockReset().mockResolvedValue([summary]);
  api.getSession.mockReset().mockResolvedValue(session);
  api.deleteSession.mockReset().mockResolvedValue({ ok: true });
  api.convert.mockReset();
  api.onStatusChanged.mockReset().mockReturnValue(() => {});
  (window.electronAPI as unknown as { workflow: { defs: { create: ReturnType<typeof vi.fn> } } }).workflow = {
    defs: { create: vi.fn() },
  };
});

describe('RecorderView', () => {
  it('lists recorded sessions and starts a new recording', async () => {
    render(<RecorderView />);

    await waitFor(() => expect(api.listSessions).toHaveBeenCalled());
    const row = await screen.findByTestId('recorder-session-sess-1');
    expect(row.textContent).toContain('Chrome · 3');
    expect(row.textContent).toContain('02:05');

    fireEvent.click(screen.getByRole('button', { name: /recorder\.start/ }));
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));
  });

  it('opens the timeline and reveals the recorded element on demand', async () => {
    const row = await openSession();
    expect(api.getSession).toHaveBeenCalledWith('sess-1');

    // The click row summarises the recorded element.
    expect(row.textContent).toContain('Submit');
    expect(row.textContent).toContain('120');

    // Password text never renders — the recorder redacted it on the way
    // to disk, so the view could not show it even if it wanted to.
    const typeRow = screen.getByTestId('recorder-event-2');
    expect(typeRow.textContent).toContain('recorder.detail.redacted');
    expect(screen.queryByText('<redacted>')).toBeNull();

    fireEvent.click(within(row).getByRole('button'));
    await waitFor(() => expect(screen.getByText('AutomationId')).toBeTruthy());
    expect(screen.getByText('btn-submit')).toBeTruthy();
  });

  it('converts a session, previews the YAML and saves under the chosen name', async () => {
    api.convert.mockResolvedValue({
      ok: true,
      def: { name: 'recorded-chrome', phases: [{ phase: 'app-1', title: 'Chrome', nodes: [] }] },
      yaml: 'name: recorded-chrome\nphases: []\n',
      warnings: ['1 app focus transit(s) without interaction dropped'],
      errors: [],
      eventCount: 3,
      droppedLines: 0,
    });
    const create = vi.fn().mockResolvedValue({ ok: true, file: '/u/.duya/workflows/x.yaml', name: 'my-flow' });
    (window.electronAPI as unknown as { workflow: { defs: { create: typeof create } } }).workflow = {
      defs: { create },
    };

    await openSession();
    fireEvent.click(screen.getByRole('button', { name: /recorder\.convert\.action/ }));
    await waitFor(() => expect(api.convert).toHaveBeenCalledWith({ sessionId: 'sess-1' }));

    // YAML preview + the auto-generated name, ready to be adjusted.
    await waitFor(() => expect(screen.getByText(/name: recorded-chrome/)).toBeTruthy());
    const nameInput = screen.getByTestId('recorder-def-name') as HTMLInputElement;
    expect(nameInput.value).toBe('recorded-chrome');
    expect(screen.getByText(/transit\(s\) without interaction/).textContent).toContain('dropped');

    fireEvent.change(nameInput, { target: { value: 'my-flow' } });
    fireEvent.click(screen.getByTestId('recorder-convert-save'));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ scope: 'global', def: { name: 'my-flow' } });
  });

  it('refuses to save an invalid definition name', async () => {
    api.convert.mockResolvedValue({ ok: true, def: { name: 'recorded-chrome' }, yaml: 'name: x\n', errors: [] });
    const create = vi.fn();
    (window.electronAPI as unknown as { workflow: { defs: { create: typeof create } } }).workflow = {
      defs: { create },
    };

    await openSession();
    fireEvent.click(screen.getByRole('button', { name: /recorder\.convert\.action/ }));
    await waitFor(() => expect(api.convert).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('recorder-def-name'), { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByTestId('recorder-convert-save'));
    await waitFor(() => expect(screen.getByText('recorder.convert.needName')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
  });

  it('deletes a session only after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RecorderView />);
    await screen.findByTestId('recorder-session-sess-1');

    fireEvent.click(screen.getByRole('button', { name: /recorder\.delete/ }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith('sess-1'));
    confirmSpy.mockRestore();
  });

  it('shows the discard affordance while recording', async () => {
    api.status.mockResolvedValue({
      ...idle,
      status: 'recording',
      sessionId: 'sess-2',
      startedAt: Date.now() - 5_000,
    });
    render(<RecorderView />);

    fireEvent.click(await screen.findByRole('button', { name: /recorder\.cancel/ }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
  });
});

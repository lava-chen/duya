// @vitest-environment jsdom
//
// Contract test for the turn-scoped review side-panel opener.
//
// The card that uses this module renders deep inside the message list, which
// is also mounted outside the PanelProvider (stories, task drawer). So the
// only channel between them is a window event, and the exact event names +
// payload shape are the interface. This test pins both, plus the two
// behaviours the caller relies on: a missing workspace/session is reported
// instead of silently dispatching, and blank fields are dropped rather than
// travelling as `""` (the panel's guards test for empty strings).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OPEN_REVIEW_PANEL_EVENT,
  REVIEW_FOCUS_FILE_EVENT,
  focusReviewFile,
  openTurnReviewInSidePanel,
} from '@/lib/review-panel';

interface Capture {
  details: Array<Record<string, unknown>>;
}

function capture(eventName: string): Capture {
  const seen: Capture = { details: [] };
  const listener = (event: Event) => {
    seen.details.push(((event as CustomEvent<Record<string, unknown>>).detail ?? {}) as Record<string, unknown>);
  };
  window.addEventListener(eventName, listener as EventListener);
  return Object.assign(seen, {
    stop: () => window.removeEventListener(eventName, listener as EventListener),
  }) as Capture & { stop: () => void };
}

describe('openTurnReviewInSidePanel', () => {
  let open: Capture & { stop: () => void };

  beforeEach(() => {
    open = capture(OPEN_REVIEW_PANEL_EVENT) as Capture & { stop: () => void };
  });
  afterEach(() => {
    open.stop();
  });

  it('opens the panel with the round identity, the file and the tab title', () => {
    const ok = openTurnReviewInSidePanel({
      workingDirectory: 'E:/repo',
      sessionId: 'session-1',
      turnId: 'turn-1',
      filePath: 'src/a.ts',
      title: '本轮变更',
    });

    expect(ok).toBe(true);
    expect(open.details).toEqual([
      {
        workingDirectory: 'E:/repo',
        sessionId: 'session-1',
        turnId: 'turn-1',
        filePath: 'src/a.ts',
        title: '本轮变更',
      },
    ]);
  });

  it('omits absent optional fields instead of sending empty strings', () => {
    const ok = openTurnReviewInSidePanel({ workingDirectory: '/repo', sessionId: 's' });

    expect(ok).toBe(true);
    // `turnId` absent = follow the session's latest round; the panel keys its
    // tab dedup on that distinction, so an empty string must not be sent.
    expect(open.details[0]).toEqual({ workingDirectory: '/repo', sessionId: 's' });
  });

  it('refuses to dispatch without a workspace root', () => {
    expect(openTurnReviewInSidePanel({ sessionId: 's', turnId: 't' })).toBe(false);
    expect(openTurnReviewInSidePanel({ workingDirectory: '   ', sessionId: 's' })).toBe(false);
    expect(open.details).toEqual([]);
  });

  it('refuses to dispatch without a session to scope the lookup to', () => {
    // Turn reviews are stored per session; without one the panel would query
    // git for a round it cannot name.
    expect(openTurnReviewInSidePanel({ workingDirectory: '/repo' })).toBe(false);
    expect(openTurnReviewInSidePanel({ workingDirectory: '/repo', sessionId: '' })).toBe(false);
    expect(open.details).toEqual([]);
  });
});

describe('focusReviewFile', () => {
  let focus: Capture & { stop: () => void };

  beforeEach(() => {
    focus = capture(REVIEW_FOCUS_FILE_EVENT) as Capture & { stop: () => void };
  });
  afterEach(() => {
    focus.stop();
  });

  it('re-targets the file inside an already-open tab', () => {
    focusReviewFile('src/b.ts');
    expect(focus.details).toEqual([{ filePath: 'src/b.ts' }]);
  });

  it('ignores a blank path rather than clearing the panel selection', () => {
    focusReviewFile('   ');
    focusReviewFile('');
    expect(focus.details).toEqual([]);
  });

  it('uses a distinct event from the open request', () => {
    // The two are not interchangeable: the open event is deduped per round and
    // creates a tab, the focus event must reach a tab that already exists.
    expect(OPEN_REVIEW_PANEL_EVENT).not.toBe(REVIEW_FOCUS_FILE_EVENT);
    const spy = vi.fn();
    window.addEventListener(OPEN_REVIEW_PANEL_EVENT, spy);
    focusReviewFile('src/c.ts');
    window.removeEventListener(OPEN_REVIEW_PANEL_EVENT, spy);
    expect(spy).not.toHaveBeenCalled();
  });
});

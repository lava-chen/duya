// @vitest-environment jsdom
//
// TurnChangesCard — the turn-scoped file-change card.
//
// The behaviour this file locks is WHERE a review opens. Both the file row and
// the 审查 button must hand the round to the side panel (ZCode's
// `ConversationFileSummaryPanel` does the same: both call `openDiff`, and the
// diff lands in the side pane's code viewer). Nothing may render inline in the
// message — the card used to expand a SimpleDiffViewer in place, which is the
// regression the "no inline diff" cases below exist to catch.
//
// The card also has to name the round precisely: `cutMessageId` is the id of
// the user message that opened it, which is what the agent persists as
// `chat_turn_reviews.turn_id`. Passing it is what makes an older round open
// its own diff instead of whatever the session did last.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { I18nProvider } from '@/components/layout/I18nProvider';
import { TurnChangesCard } from '@/components/chat/TurnChangesCard';
import { setTurnChangesCard } from '@/stores/turn-changes-card-store';
import type { ToolAction } from '@/components/chat/tools/types';

// The card is rendered by MessageItem inside a tree that already provides
// i18n; there is no ambient provider in jsdom.
const withI18n = ({ children }: { children: React.ReactNode }) => (
  <I18nProvider>{children}</I18nProvider>
);

/** A distinctive body so an inline diff (if any) is unmistakable in the DOM. */
const MARKER = 'const SIDEBAR_ONLY_MARKER = 1;';

function writeTool(path: string): ToolAction {
  return {
    id: `t-${path}`,
    name: 'write',
    input: { file_path: path, content: `${MARKER}\nconst b = 2;\n` },
    result: `Successfully wrote 42 characters (2 lines) to '${path}'`,
  };
}

interface Captured {
  open: Array<Record<string, unknown>>;
  focus: Array<Record<string, unknown>>;
}

function captureReviewEvents(): { seen: Captured; stop: () => void } {
  const seen: Captured = { open: [], focus: [] };
  const onOpen = (event: Event) => {
    seen.open.push(((event as CustomEvent<Record<string, unknown>>).detail ?? {}) as Record<string, unknown>);
  };
  const onFocus = (event: Event) => {
    seen.focus.push(((event as CustomEvent<Record<string, unknown>>).detail ?? {}) as Record<string, unknown>);
  };
  window.addEventListener('duya:open-review-panel', onOpen as EventListener);
  window.addEventListener('duya:review-focus-file', onFocus as EventListener);
  return {
    seen,
    stop: () => {
      window.removeEventListener('duya:open-review-panel', onOpen as EventListener);
      window.removeEventListener('duya:review-focus-file', onFocus as EventListener);
    },
  };
}

/** Expand the card so the per-file rows are in the DOM. */
function expandCard(): void {
  const header = document.querySelector('[aria-expanded]') as HTMLElement | null;
  if (!header) throw new Error('card header not found');
  act(() => {
    fireEvent.click(header);
  });
}

function fileRow(fileName: string): HTMLElement {
  // The row itself, not the caret button nested inside it (both carry the
  // path as `title`; only the row carries aria-disabled).
  const row = Array.from(
    document.querySelectorAll('[role="button"][title][aria-disabled]'),
  ).find((element) => (element as HTMLElement).getAttribute('title')?.endsWith(fileName)) as
    | HTMLElement
    | undefined;
  if (!row) throw new Error(`file row for ${fileName} not found`);
  return row;
}

const CWD = 'E:/repo';

describe('TurnChangesCard review routing', () => {
  let events: { seen: Captured; stop: () => void };

  beforeEach(() => {
    events = captureReviewEvents();
  });
  afterEach(() => {
    events.stop();
    cleanup();
  });

  it('opens the round in the side panel when the file row is clicked', () => {
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expandCard();

    act(() => {
      fireEvent.click(fileRow('src/a.ts'));
    });

    expect(events.seen.open).toEqual([
      {
        workingDirectory: CWD,
        sessionId: 'session-1',
        turnId: 'turn-1',
        filePath: 'src/a.ts',
        title: expect.any(String),
      },
    ]);
  });

  it('re-targets the file so an already-open tab follows the click', () => {
    // The tab is deduped per round, so a second click on a different file has
    // to travel by focus event — a reused tab keeps its original params.
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expandCard();

    act(() => {
      fireEvent.click(fileRow('src/a.ts'));
    });

    expect(events.seen.focus).toEqual([{ filePath: 'src/a.ts' }]);
  });

  it('does the same from the 审查 button', () => {
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expandCard();

    const reviewButton = fileRow('src/a.ts').querySelectorAll('button')[0] as HTMLButtonElement;
    act(() => {
      fireEvent.click(reviewButton);
    });

    expect(events.seen.open).toHaveLength(1);
    expect(events.seen.open[0].filePath).toBe('src/a.ts');
    expect(events.seen.open[0].turnId).toBe('turn-1');
  });

  it('never renders the diff inside the message', () => {
    // The whole point of routing to the sidebar: the round's content stays out
    // of the transcript. A prior revision expanded a SimpleDiffViewer inline
    // here, and that is exactly what must not come back.
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expect(document.body.textContent).not.toContain(MARKER);
    expandCard();
    expect(document.body.textContent).not.toContain(MARKER);

    act(() => {
      fireEvent.click(fileRow('src/a.ts'));
    });
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('disables review when the workspace root is unknown', () => {
    // Without a cwd the panel cannot scope git, so the control is inert rather
    // than dispatching a request that quietly does nothing.
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={null}
          />
        ),
      }),
    );
    expandCard();

    const row = fileRow('src/a.ts');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    const reviewButton = row.querySelectorAll('button')[0] as HTMLButtonElement;
    expect(reviewButton.disabled).toBe(true);

    act(() => {
      fireEvent.click(row);
      fireEvent.click(reviewButton);
    });
    expect(events.seen.open).toEqual([]);
  });

  it('disables review when the round has no id to look the review up by', () => {
    // `cutMessageId` is null for the first visible round after a scroll
    // boundary; there is no honest way to name that round's review.
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId={null}
            cwd={CWD}
          />
        ),
      }),
    );
    expandCard();

    const reviewButton = fileRow('src/a.ts').querySelectorAll('button')[0] as HTMLButtonElement;
    expect(reviewButton.disabled).toBe(true);
    act(() => {
      fireEvent.click(reviewButton);
    });
    expect(events.seen.open).toEqual([]);
  });

  it('still aggregates repeated edits to one file into a single row', () => {
    // Guards the summary derivation while touching the card's click paths.
    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts'), writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expandCard();
    // One row per file: the row div is the only [role="button"][title] node
    // carrying aria-disabled (the caret inside it is a plain <button>).
    expect(document.querySelectorAll('[role="button"][title][aria-disabled]')).toHaveLength(1);
    expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0);
  });

  it('renders nothing for a round that changed no files', () => {
    const { container } = render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[{ id: 't-read', name: 'read', input: { file_path: 'src/a.ts' } }]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expect(container.textContent).toBe('');
  });
});

describe('TurnChangesCard undo', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps undo scoped to the round that opened it', async () => {
    const restoreFiles = vi.fn(async () => ({ restoredFiles: ['src/a.ts'], failedCount: 0 }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { message: { restoreFiles } };

    render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );

    const undoButton = screen.getByTitle(/\u64a4\u9500|Undo/);
    await act(async () => {
      fireEvent.click(undoButton);
    });

    expect(restoreFiles).toHaveBeenCalledWith('session-1', 'turn-1');
  });
});

// Settings switch (`display.turn_changes_card`). The real store is used —
// jsdom has no config port, so `setTurnChangesCard` only flips the module
// snapshot, which is exactly the input the card's early return reads.
describe('TurnChangesCard settings switch', () => {
  const setSwitch = (value: boolean) => {
    act(() => {
      setTurnChangesCard(value);
    });
  };

  afterEach(() => {
    setSwitch(true);
    cleanup();
  });

  it('renders nothing when the switch is off, with no review side effects', () => {
    const events = captureReviewEvents();
    try {
      setSwitch(false);
      const { container } = render(
        withI18n({
          children: (
            <TurnChangesCard
              tools={[writeTool('src/a.ts')]}
              sessionId="session-1"
              cutMessageId="turn-1"
              cwd={CWD}
            />
          ),
        }),
      );
      expect(container.textContent).toBe('');
      expect(events.seen.open).toEqual([]);
    } finally {
      events.stop();
    }
  });

  it('renders again once the switch is back on', () => {
    setSwitch(false);
    const off = render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expect(off.container.textContent).toBe('');
    off.unmount();

    setSwitch(true);
    const on = render(
      withI18n({
        children: (
          <TurnChangesCard
            tools={[writeTool('src/a.ts')]}
            sessionId="session-1"
            cutMessageId="turn-1"
            cwd={CWD}
          />
        ),
      }),
    );
    expect(on.container.querySelector('[aria-expanded]')).not.toBeNull();
  });
});

// @vitest-environment jsdom
//
// CodeReviewPanel — the turn-pinned open path.
//
// The transcript's file-change card hands a round to this panel by id (the
// user message that opened it, which the agent stores as
// `chat_turn_reviews.turn_id`). These tests pin the two halves of that
// contract:
//
//   - `params.reviewTurnId` loads THAT round instead of the session's latest,
//     and `params.reviewFilePath` reveals the file the user actually clicked
//     (otherwise the panel selects the first file of the round and buries it);
//   - a reused tab — which keeps its original params — is re-targeted through
//     the `duya:review-focus-file` event, and a file that is not part of the
//     round being shown is ignored rather than blanking the selection.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup, act } from '@testing-library/react';

const gitIpc = vi.hoisted(() => ({
  getGitLatestTurnReview: vi.fn(),
  getGitTurnHistory: vi.fn(),
  getGitTurnDetail: vi.fn(),
  getGitTurnReviewByTurnId: vi.fn(),
  getGitReviewScoped: vi.fn(),
  getGitCommits: vi.fn(),
}));

vi.mock('@/lib/git-ipc', () => ({
  getGitLatestTurnReview: gitIpc.getGitLatestTurnReview,
  getGitTurnHistory: gitIpc.getGitTurnHistory,
  getGitTurnDetail: gitIpc.getGitTurnDetail,
  getGitTurnReviewByTurnId: gitIpc.getGitTurnReviewByTurnId,
  getGitReviewScoped: gitIpc.getGitReviewScoped,
  getGitCommits: gitIpc.getGitCommits,
}));

import { CodeReviewPanel } from '@/components/layout/panels/CodeReviewPanel';
import type { PageTab } from '@/components/layout/panels/registry';

const CWD = 'E:/repo';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old-a',
  '+new-a',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1 @@',
  '-old-b',
  '+new-b',
  '',
].join('\n');

const FILES = [
  { path: 'src/a.ts', status: 'modified' as const, additions: 1, removals: 1 },
  { path: 'src/b.ts', status: 'modified' as const, additions: 1, removals: 1 },
];

function storedReview(turnId: string) {
  return {
    isGitRepo: true,
    review: {
      id: `row-${turnId}`,
      sessionId: 'session-1',
      turnId,
      workingDirectory: CWD,
      files: FILES,
      totals: { additions: 2, removals: 2, fileCount: 2 },
      patch: PATCH,
      truncated: false,
      binary: false,
      capturedAt: 1,
    },
  };
}

function makeTab(params: Record<string, unknown>): PageTab {
  return { id: 'tab-1', pageId: 'review', title: '本轮变更', params };
}

/** The diff section the panel currently marks as selected. */
function selectedSectionId(): string | undefined {
  return document.querySelector('.code-review-file-section.is-selected')?.id;
}

async function waitForReview(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelectorAll('.code-review-file-section').length).toBe(2);
  });
}

describe('CodeReviewPanel turn-pinned open', () => {
  beforeEach(() => {
    for (const fn of Object.values(gitIpc)) fn.mockReset();
    gitIpc.getGitTurnHistory.mockResolvedValue({ isGitRepo: true, turns: [] });
    gitIpc.getGitReviewScoped.mockResolvedValue({ isGitRepo: true, files: [] });
    gitIpc.getGitCommits.mockResolvedValue({ commits: [] });
    // jsdom has no element scroll implementation; the panel scrolls to the
    // focused file after re-targeting.
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('loads the pinned round instead of the session latest', async () => {
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue(storedReview('turn-9'));
    gitIpc.getGitLatestTurnReview.mockResolvedValue(storedReview('turn-latest'));

    render(
      <CodeReviewPanel
        tab={makeTab({ workingDirectory: CWD, sessionId: 'session-1', reviewTurnId: 'turn-9' })}
        embedded={false}
      />,
    );

    await waitFor(() => {
      expect(gitIpc.getGitTurnReviewByTurnId).toHaveBeenCalledWith('session-1', CWD, 'turn-9');
    });
    // Following the session's latest would show a different round than the
    // card that opened this tab.
    expect(gitIpc.getGitLatestTurnReview).not.toHaveBeenCalled();
    await waitForReview();
  });

  it('follows the session latest when no round is pinned', async () => {
    gitIpc.getGitLatestTurnReview.mockResolvedValue(storedReview('turn-latest'));

    render(
      <CodeReviewPanel
        tab={makeTab({ workingDirectory: CWD, sessionId: 'session-1' })}
        embedded={false}
      />,
    );

    await waitFor(() => {
      expect(gitIpc.getGitLatestTurnReview).toHaveBeenCalledWith('session-1', CWD);
    });
    expect(gitIpc.getGitTurnReviewByTurnId).not.toHaveBeenCalled();
  });

  it('reveals the clicked file rather than the first file of the round', async () => {
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue(storedReview('turn-9'));

    render(
      <CodeReviewPanel
        tab={makeTab({
          workingDirectory: CWD,
          sessionId: 'session-1',
          reviewTurnId: 'turn-9',
          reviewFilePath: 'src/b.ts',
        })}
        embedded={false}
      />,
    );

    await waitForReview();
    await waitFor(() => {
      expect(selectedSectionId()).toBe('review-file-src/b.ts');
    });
  });

  it('falls back to the first file when the requested one is not in the round', async () => {
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue(storedReview('turn-9'));

    render(
      <CodeReviewPanel
        tab={makeTab({
          workingDirectory: CWD,
          sessionId: 'session-1',
          reviewTurnId: 'turn-9',
          reviewFilePath: 'src/gone.ts',
        })}
        embedded={false}
      />,
    );

    await waitForReview();
    await waitFor(() => {
      expect(selectedSectionId()).toBe('review-file-src/a.ts');
    });
  });

  it('re-targets an already-open tab when the card dispatches a focus event', async () => {
    // A reused tab keeps its original params, so the second click can only
    // arrive as an event.
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue(storedReview('turn-9'));

    render(
      <CodeReviewPanel
        tab={makeTab({
          workingDirectory: CWD,
          sessionId: 'session-1',
          reviewTurnId: 'turn-9',
          reviewFilePath: 'src/a.ts',
        })}
        embedded={false}
      />,
    );

    await waitForReview();
    await waitFor(() => {
      expect(selectedSectionId()).toBe('review-file-src/a.ts');
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('duya:review-focus-file', { detail: { filePath: 'src/b.ts' } }));
    });

    await waitFor(() => {
      expect(selectedSectionId()).toBe('review-file-src/b.ts');
    });
  });

  it('ignores a focus event for a file outside the round on display', async () => {
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue(storedReview('turn-9'));

    render(
      <CodeReviewPanel
        tab={makeTab({
          workingDirectory: CWD,
          sessionId: 'session-1',
          reviewTurnId: 'turn-9',
          reviewFilePath: 'src/a.ts',
        })}
        embedded={false}
      />,
    );

    await waitForReview();
    await waitFor(() => {
      expect(selectedSectionId()).toBe('review-file-src/a.ts');
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('duya:review-focus-file', { detail: { filePath: 'src/other.ts' } }));
      window.dispatchEvent(new CustomEvent('duya:review-focus-file', { detail: {} }));
    });

    // Selection must survive — a stray dispatch from another round must not
    // clear what the user is looking at.
    expect(selectedSectionId()).toBe('review-file-src/a.ts');
  });

  it('states both reasons a pinned round can have no record', async () => {
    // No row means either "this round changed nothing" or "the agent captured
    // no baseline (not a git repo)". The lookup cannot tell them apart, so the
    // copy must not pick one and assert it.
    gitIpc.getGitTurnReviewByTurnId.mockResolvedValue({ isGitRepo: true });

    render(
      <CodeReviewPanel
        tab={makeTab({ workingDirectory: CWD, sessionId: 'session-1', reviewTurnId: 'turn-9' })}
        embedded={false}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain('本轮没有可用的变更记录');
    });
    expect(document.body.textContent).toContain('尚无变更记录');
  });
});

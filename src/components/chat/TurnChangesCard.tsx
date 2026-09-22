// TurnChangesCard — plan 566: the turn-scoped file-change card rendered at
// the end of every assistant round.
//
// Visual + structural parity with ZCode's `ConversationFileSummaryPanel`
// (packages/ui/src/v4/ConversationFileSummaryPanel.tsx). That file is the
// reference for every class name, spacing value and element order below; the
// intentional divergences are listed at the bottom of this comment.
//
// The important distinction from FileEditToolRow: this card is ONE PER TURN,
// not one per tool. A round that edits the same file three times shows a
// single row with the aggregate counts. FileEditToolRow keeps showing the
// per-call rows above it — the card is the roll-up at the bottom.
//
// Layout mirrors the reference:
//   ┌ ⌄  3 个文件已更改  +18 -7                        [↩ 撤销] ┐
//   │ <icon> plan-556.md  src/lib   +18 -7   [审查] [打开│▾]  │
//
// Three actions, each delegating to an existing duya capability:
//   - 撤销   → `electronAPI.message.restoreFiles`, which writes pre-image
//              snapshots back to disk WITHOUT rewinding the conversation
//              (plan 429 #3). The cut point is the user message that opened
//              the round, so the handler's `events.slice(cutIdx + 1)` covers
//              exactly this turn.
//   - 审查   → the `review` side panel, pinned to this round. Both the file
//              row and the 审查 button route here, and NOTHING expands inside
//              the message. This matches the reference, where both call
//              `openDiff` and land in the side pane's code viewer. The diff
//              shown is the round's persisted git review (baseline tree →
//              end of turn, captured by the agent), addressed by
//              `cutMessageId` — the same id the agent stores as `turn_id` —
//              so an older round opens its own diff rather than the
//              session's latest one.
//   - 打开   → split button. Main half calls openLocalArtifactTarget (the
//              same router FileEditToolRow uses); the caret half opens a
//              menu of ways to get at the file.
//
// Intentional divergences from the reference component:
//   1. ZCode fetches per-file patches over IPC (`fetchFileChanges`) with a
//      cache policy keyed to turn state. duya derives the summary from the
//      tool actions it already has, so there is no loading/error state here.
//   2. ZCode's "open with" menu lists installed editors discovered from the
//      OS. duya has no editor-discovery bridge, so the menu offers the
//      capabilities duya actually has.
//   3. Reviewing needs a session + workspace root; without them the control
//      is disabled rather than silently inert.

'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CaretDownIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  CopyIcon,
  FolderOpenIcon,
  SpinnerGapIcon,
} from '@/components/icons';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { useTranslation } from '@/hooks/useTranslation';
import { buildFileChangeSummaries } from '@/lib/tool-file-changes';
import { openLocalArtifactTarget } from '@/lib/chat-file-links';
import { focusReviewFile, openTurnReviewInSidePanel } from '@/lib/review-panel';
import { useTurnChangesCardEnabled } from '@/stores/turn-changes-card-store';
import { fileExtensionFromName, getFileTypeIcon } from '@/components/file-tree/file-type-icon';
import type { ToolAction } from './tools/types';

interface TurnChangesCardProps {
  /** Every tool action of this round — same array the group already built. */
  tools: ToolAction[];
  /** Active session id, used as the restore scope. */
  sessionId: string | null;
  /** Id of the user message that opened this round. Files changed by events
   *  AFTER it are exactly this turn's changes, and it is also the key the
   *  round's persisted review is stored under. */
  cutMessageId: string | null;
  /** Thread working directory, used to shorten the displayed path and to
   *  resolve relative paths on open. */
  cwd?: string | null;
  /** True while the round is still streaming — undo is meaningless then. */
  disabled?: boolean;
}

/**
 * `+N -M` counters.
 *
 * Uses the `--diff-added` / `--diff-removed` variables rather than Tailwind
 * palette colors: this project themes through `data-theme` + CSS variables,
 * NOT through Tailwind's `dark:` variant (which keys off
 * `prefers-color-scheme` and therefore never fires here). Hardcoding a hex
 * made the header counters unreadable in dark mode. Those two variables are
 * the ones the git drawer's 更改 row and the code review panel already share,
 * so the colors stay in sync with the rest of the app for free.
 */
function DiffStats({ additions, removals }: { additions: number; removals: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums text-sm">
      {additions > 0 && (
        <span className="text-[var(--diff-added)]">+{additions}</span>
      )}
      {removals > 0 && (
        <span className="text-[var(--diff-removed)]">-{removals}</span>
      )}
    </span>
  );
}

/**
 * Button base rule, mirroring ZCode's `buttonVariants` base.
 *
 * Why these controls are plain <button>s instead of duya's <Button>:
 * `<Button>` builds its class string by bare concatenation (no
 * tailwind-merge), so anything passed through `className` that collides with
 * a size/variant utility is a coin flip — Tailwind resolves conflicts by
 * STYLESHEET order, not by class-attribute order. Measured: `text-sm` and
 * `px-2` passed to `<Button size="sm">` both lost to the preset's `text-xs`
 * and `px-3`, and the caret ended up 0px wide (its `w-5` lost to `px-3`, so
 * the icon had no content box left). ZCode gets exact geometry because it
 * merges classes with `cn()`. These buttons instead carry the resolved
 * geometry literally, keeping duya's tokens for every colour.
 */
const BTN_BASE =
  'inline-flex shrink-0 items-center justify-center whitespace-nowrap border border-transparent bg-clip-padding transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40';

/** ZCode `variant="ghost"` — `text-foreground hover:bg-hover`. */
const BTN_GHOST = 'text-foreground hover:bg-surface-hover';

/** ZCode `variant="outline"` — bordered, tinted input surface. */
const BTN_OUTLINE =
  'border-border bg-input text-foreground hover:border-muted-foreground/30 hover:bg-input/50';

/**
 * Shorten an absolute path to something workspace-relative, mirroring
 * ZCode's `toWorkspaceRelativePath`. Falls back to the original path when
 * there is no usable workspace root.
 */
function toWorkspaceRelativePath(
  workspacePath: string | null | undefined,
  filePath: string,
): string {
  if (!workspacePath) return filePath;
  const root = workspacePath.replace(/[/\\]+$/, '');
  if (!root) return filePath;
  const normalised = filePath.replace(/\\/g, '/');
  const normalisedRoot = root.replace(/\\/g, '/');
  if (normalised.toLowerCase().startsWith(`${normalisedRoot.toLowerCase()}/`)) {
    return normalised.slice(normalisedRoot.length + 1);
  }
  return filePath;
}

export function TurnChangesCard({
  tools,
  sessionId,
  cutMessageId,
  cwd,
  disabled = false,
}: TurnChangesCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [undoState, setUndoState] = useState<'idle' | 'running'>('idle');
  const [undoResult, setUndoResult] = useState<string | null>(null);

  // Settings switch (`display.turn_changes_card`, General → 应用). Hiding
  // the card takes the whole roll-up with it — undo, review routing, open —
  // while the per-call tool rows in the message stay untouched. The flag is
  // read BEFORE the early return below but AFTER every other hook, so the
  // return stays hook-safe.
  const cardEnabled = useTurnChangesCardEnabled();

  // Aggregate across the round: same path touched three times collapses into
  // one summary with summed stats. Pure derivation over the already-paired
  // tool actions — no IPC, no refetch.
  const changes = useMemo(() => buildFileChangeSummaries(tools), [tools]);

  const totals = useMemo(
    () =>
      changes.reduce(
        (acc, change) => ({
          additions: acc.additions + change.additions,
          removals: acc.removals + change.removals,
        }),
        { additions: 0, removals: 0 },
      ),
    [changes],
  );

  const canUndo = Boolean(sessionId && cutMessageId) && !disabled && undoState !== 'running';
  // Reviewing reads the round's persisted git review. That needs the session
  // (reviews are stored per session), the workspace root (git scope) and the
  // round's id (it IS the lookup key). Any of them missing means the panel
  // could only show some OTHER round under this card's header, so the control
  // is disabled rather than quietly misleading.
  const canReview = Boolean(sessionId && cwd && cutMessageId);

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;
    setUndoState('running');
    setUndoResult(null);
    try {
      const outcome = await window.electronAPI.message.restoreFiles(
        sessionId as string,
        cutMessageId as string,
      );
      const restoredCount = outcome?.restoredFiles?.length ?? 0;
      // `restoreFiles` only rewrites paths that have a pre-image snapshot.
      // A file created by this turn has none, so it stays on disk — count it
      // as not-reverted instead of reporting a clean success.
      const notReverted =
        (outcome?.failedCount ?? 0) + Math.max(0, changes.length - restoredCount);
      if (restoredCount === 0) {
        setUndoResult(t('turnChanges.undoFailed'));
      } else if (notReverted > 0) {
        setUndoResult(
          t('turnChanges.undoPartial', { count: restoredCount, failed: notReverted }),
        );
      } else {
        setUndoResult(t('turnChanges.undoDone', { count: restoredCount }));
      }
    } catch {
      setUndoResult(t('turnChanges.undoFailed'));
    } finally {
      setUndoState('idle');
    }
  }, [canUndo, sessionId, cutMessageId, changes.length, t]);

  const handleOpen = useCallback(
    (path: string) => {
      openLocalArtifactTarget(path, cwd);
    },
    [cwd],
  );

  /**
   * Show this round's diff for one file, in the side panel.
   *
   * Two dispatches on purpose: the open event creates the tab when there is
   * none (carrying the file so the panel can select it as soon as the diff
   * loads), and the focus event re-targets the tab when it already exists —
   * a reused tab keeps its original params, so the file can only travel by
   * event. Both are no-ops when the target is already showing.
   */
  const handleReview = useCallback(
    (path: string) => {
      if (!canReview) return;
      const opened = openTurnReviewInSidePanel({
        workingDirectory: cwd,
        sessionId,
        turnId: cutMessageId,
        filePath: path,
        title: t('turnChanges.reviewTitle'),
      });
      if (!opened) return;
      focusReviewFile(path);
    },
    [canReview, cwd, sessionId, cutMessageId, t],
  );

  const buildOpenMenu = useCallback(
    (path: string) => [
      {
        kind: 'action' as const,
        id: 'reveal',
        label: t('turnChanges.revealInFolder'),
        iconLeft: <FolderOpenIcon size={14} />,
        onSelect: () => {
          void window.electronAPI?.shell?.showItemInFolder?.(path);
        },
      },
      {
        kind: 'action' as const,
        id: 'copy-path',
        label: t('turnChanges.copyPath'),
        iconLeft: <CopyIcon size={14} />,
        onSelect: () => {
          void navigator.clipboard?.writeText(path);
        },
      },
    ],
    [t],
  );

  if (!cardEnabled || changes.length === 0) return null;

  const filesChangedLabel = t('turnChanges.title', { count: changes.length });

  return (
    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-none">
      {/* Header — h-10, chevron on the LEFT of the label, undo on the right.
          The whole row tints on hover (reference: `hover:bg-hover`). */}
      <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-surface-hover">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-label={expanded ? t('turnChanges.collapse') : t('turnChanges.expand')}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <CaretRightIcon
            size={14}
            className={`shrink-0 text-muted-foreground/60 transition-transform ${
              expanded ? 'rotate-90' : 'rotate-0'
            }`}
          />
          <span className="min-w-0 truncate font-medium">{filesChangedLabel}</span>
          <DiffStats additions={totals.additions} removals={totals.removals} />
          {undoResult && (
            <span className="shrink-0 rounded-sm bg-input px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {undoResult}
            </span>
          )}
        </button>

        {/* ZCode: Button variant="ghost" size="sm" → h-6 px-2 gap-1, 14px. */}
        <button
          type="button"
          disabled={!canUndo}
          onClick={handleUndo}
          title={t('turnChanges.undo')}
          className={`${BTN_BASE} ${BTN_GHOST} h-6 gap-1 rounded-md px-2 text-sm/relaxed`}
        >
          {undoState === 'running' ? (
            <SpinnerGapIcon size={14} className="shrink-0 animate-spin" />
          ) : (
            <ClockCounterClockwiseIcon size={14} className="shrink-0" />
          )}
          <span>{undoState === 'running' ? t('turnChanges.undoing') : t('turnChanges.undo')}</span>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div className="grid w-full border-t border-border">
              {changes.map((change) => {
                const TypeIcon = getFileTypeIcon(fileExtensionFromName(change.name));
                const relativePath = toWorkspaceRelativePath(cwd, change.path);

                return (
                  <div key={change.path} className="w-full overflow-hidden bg-background/50">
                    <div
                      role="button"
                      aria-disabled={!canReview}
                      tabIndex={canReview ? 0 : -1}
                      title={change.path}
                      onClick={() => handleReview(change.path)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        if (!canReview) return;
                        event.preventDefault();
                        handleReview(change.path);
                      }}
                      className={`flex w-full items-center gap-1 px-2 py-2 text-left transition-colors ${
                        canReview ? 'cursor-pointer hover:bg-surface-hover/30' : 'cursor-default'
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {TypeIcon && (
                            <TypeIcon size={16} className="shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate text-sm font-medium text-foreground">
                            {change.name}
                          </span>
                          <span className="truncate text-sm text-muted-foreground">
                            {relativePath}
                          </span>
                        </div>
                        <DiffStats additions={change.additions} removals={change.removals} />
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {/* ZCode: Button variant="outline" size="default" with
                            className "h-7 gap-1.5 rounded-lg bg-input px-2". */}
                        <button
                          type="button"
                          disabled={!canReview}
                          title={t('turnChanges.review')}
                          aria-label={t('turnChanges.review')}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleReview(change.path);
                          }}
                          className={`${BTN_BASE} ${BTN_OUTLINE} h-7 gap-1.5 rounded-lg px-2 text-sm/relaxed`}
                        >
                          <span>{t('turnChanges.review')}</span>
                        </button>

                        {/* Split button — one bordered shell holding the primary
                            action and a caret that opens the "open with" menu. */}
                        <div
                          className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleOpen(change.path);
                            }}
                            className={`${BTN_BASE} ${BTN_GHOST} h-7 gap-1 rounded-none border-0 pl-2 pr-1.5 text-sm/relaxed`}
                          >
                            {t('turnChanges.open')}
                          </button>
                          <DropdownMenu
                            align="end"
                            side="above"
                            items={buildOpenMenu(change.path)}
                            trigger={
                              // No onClick/stopPropagation here: DropdownMenu
                              // toggles on its own wrapper div, which sits
                              // BETWEEN this button and the split-button shell.
                              // Stopping propagation on the button would swallow
                              // the toggle and the menu would never open. The
                              // shell's handler still keeps the click off the row.
                              <button
                                type="button"
                                aria-label={t('turnChanges.open')}
                                title={change.path}
                                className={`${BTN_BASE} ${BTN_GHOST} h-7 w-5 rounded-none border-0 px-0 text-muted-foreground/60`}
                              >
                                <CaretDownIcon size={14} className="shrink-0" />
                              </button>
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default TurnChangesCard;

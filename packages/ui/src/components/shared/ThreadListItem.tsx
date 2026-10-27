"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { ArchiveIcon, DotsThreeIcon, CopyIcon, NotePencilIcon, CircleNotchIcon, PinIcon, PinFilledIcon, TrashIcon, DownloadSimpleIcon, WarningIcon, FolderOpenIcon } from "@/components/icons";
import { SessionWorktreeBadges } from "@/components/shared/SessionWorktreeBadges";
import { useSessionUnreadBadge } from "@/hooks/useSessionUnreadBadge";
import { exportRolloutIPC } from "@/lib/ipc-client";
import { showNotification } from "@/lib/notification";
import {
  subscribeToPhase,
  subscribeToPermissions,
  subscribeToConnectorAuthRequired,
  type ConnectorAuthRequiredData,
} from "@/lib/stream-session-manager";
import { useTranslation } from "@/hooks/useTranslation";
import type { StreamPhase } from "@/types/message";
import type { PermissionRequestEvent } from "@/types/stream";
import type { TranslationKey } from "@/i18n";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { ArchiveConfirm } from "@/components/shared/ArchiveConfirm";

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface ThreadListItemProps {
  thread: Thread;
  isActive: boolean;
}

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

/**
 * Claude parity (2026-10-27): the trailing state dot carries one of three
 * meanings, all of them taken from a live Claude Code desktop window:
 *
 *   amber   — the session stopped and needs the user (a question, an
 *             approval, a connector auth).
 *   blue    — the session finished but the user has not looked at it yet.
 *   red     — the last turn failed.
 *
 * `running` keeps its spinner, and `idle` renders nothing at all — the
 * resting state is not news.
 *
 * `Thread` has no `status` column, so the running / awaiting / error states
 * are derived from the stream phase the renderer already subscribes to. The
 * "finished but unseen" state has no phase to read: it is the unread stamp
 * in `useSessionSeenStore` — no new persistence, no IPC.
 */
type SessionStatus = "idle" | "running" | "awaiting" | "error" | "unread";


function formatTimeAgo(t: TFunc, timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(diff / 604800000);

  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return `${weeks}w`;
}

export function ThreadListItem({ thread, isActive }: ThreadListItemProps) {
  const { t } = useTranslation();
  // Plan 535 / 506 closeout: precise per-action selectors so the row only
  // re-renders when one of the slice values changes (pin toggle from
  // another row, etc.), not on every unrelated thread/message churn.
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const deleteThread = useConversationStore((s) => s.deleteThread);
  const archiveThread = useConversationStore((s) => s.archiveThread);
  // Plan 549 (Track B): unarchive -- reverse the rename, restore the
  // session to the active list. The store action drops the row from
  // archivedThreads optimistically and re-fetches the active list.
  const unarchiveThread = useConversationStore((s) => s.unarchiveThread);
  const updateThreadTitle = useConversationStore((s) => s.updateThreadTitle);
  const setThreadPinned = useConversationStore((s) => s.setThreadPinned);
  // Plan 582 (G9): how many sub-agent sessions the archive batch will take
  // with this row, so the confirm dialog can say so before the click lands.
  const threads = useConversationStore((s) => s.threads);
  const [isArchiveConfirmOpen, setIsArchiveConfirmOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(thread.title || "");
  // Keep the raw phase (not just a boolean) so the row can tell "failed"
  // apart from "not running" — the stream phase is the only per-session
  // runtime signal the renderer has.
  const [phase, setPhase] = useState<StreamPhase>("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = thread.title || t('thread.newThread');

  // Subscribe to stream phase changes to derive the row's trailing state.
  useEffect(() => {
    const unsubscribe = subscribeToPhase(thread.id, (next) => {
      setPhase(next);
    });
    return unsubscribe;
  }, [thread.id]);

  // Plan 516 — "waiting on user" trailing pill. Mirrors the same
  // subscriptions BotContactListItem uses, so a paused permission /
  // connector-auth request shows a pill on the sidebar thread row
  // regardless of which chat is focused. Priority in the trailing slot:
  // awaiting-input > running > pinned > time.
  type AwaitingInputKind = 'ask' | 'permission' | 'auth';
  const [awaitingInput, setAwaitingInput] = useState<AwaitingInputKind | null>(null);
  useEffect(() => {
    const unsubPerm = subscribeToPermissions(thread.id, (request: PermissionRequestEvent | null) => {
      if (request == null) {
        setAwaitingInput(null);
        return;
      }
      const kind: AwaitingInputKind =
        request.toolName === 'AskUserQuestion' || request.mode === 'ask_user_question'
          ? 'ask'
          : 'permission';
      setAwaitingInput(kind);
    });
    const unsubAuth = subscribeToConnectorAuthRequired(thread.id, (data: ConnectorAuthRequiredData | null) => {
      setAwaitingInput(data ? 'auth' : null);
    });
    return () => {
      unsubPerm();
      unsubAuth();
    };
  }, [thread.id]);

  const isRunning = ACTIVE_PHASES.includes(phase);
  // "Finished, but the user has not looked at it yet" — the blue dot. The
  // hook asks the agent server whether the session is still running, because
  // a session that ran in the background leaves the renderer with no stream
  // state and would otherwise read as idle.
  const unread = useSessionUnreadBadge(thread.id, isRunning || awaitingInput != null);
  // A blocked session is the most actionable state on the row, and
  // `awaiting_permission` is itself an active phase — so "awaiting" has to
  // win over "running" or the amber dot would never show.
  const sessionStatus: SessionStatus =
    phase === "error"
      ? "error"
      : awaitingInput != null
        ? "awaiting"
        : isRunning
          ? "running"
          : unread
            ? "unread"
            : "idle";
  const statusLabel = {
    idle: t("thread.status.idle"),
    running: t("thread.status.running"),
    awaiting: t("thread.status.awaitingInput"),
    error: t("thread.status.error"),
    unread: t("thread.status.unread"),
  }[sessionStatus];
  // Codex parity (2026-10-22): the row carries NO leading glyph. Codex
  // renders the title flush with the group header's left edge and signals
  // state only in the trailing slot (spinner / status dot / PR mark), so a
  // 20-row list stays scannable. Claude Code's leading hollow ring was
  // tried and dropped: it cost 12px per row and pushed the titles off the
  // header's alignment.
  // `idle` therefore renders nothing at all — the resting state is not news.
  const showTrailingStatus = sessionStatus !== "idle";

  const handleClick = () => {
    if (!isRenaming) {
      setActiveThread(thread.id);
    }
  };

  // DropdownMenu owns click-outside / Esc / positioning — no manual
  // `showMenu` state, refs, or context-menu plumbing needed.

  const handleRename = useCallback(() => {
    setIsRenaming(true);
    setNewTitle(thread.title || "");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [thread.title]);

  const handleRenameSubmit = useCallback(() => {
    if (newTitle.trim() && newTitle !== thread.title) {
      updateThreadTitle(thread.id, newTitle.trim());
    }
    setIsRenaming(false);
  }, [newTitle, thread.id, thread.title, updateThreadTitle]);

  const handleRenameCancel = useCallback(() => {
    setIsRenaming(false);
    setNewTitle(thread.title || "");
  }, [thread.title]);

  const handleCopyId = useCallback(() => {
    navigator.clipboard.writeText(thread.id);
  }, [thread.id]);

  const handleDelete = useCallback(() => {
    deleteThread(thread.id);
  }, [deleteThread, thread.id]);

  // Plan 582 (G9): archiving is now a confirm-then-act flow, because
  // `db:session:archive` takes the session's whole spawn subtree with it —
  // one click on a parent conversation files away every sub-agent session
  // underneath it, and nothing on screen said so.
  const handleArchive = useCallback(async () => {
    await archiveThread(thread.id);
  }, [archiveThread, thread.id]);

  const handleOpenArchiveConfirm = useCallback(() => {
    setIsArchiveConfirmOpen(true);
  }, []);

  const handleArchiveConfirmCancel = useCallback(() => {
    setIsArchiveConfirmOpen(false);
  }, []);

  // Plan 582 (G2): the archive batch covers every descendant. Count them from
  // the live roster so the dialog can say what it is about to take; the main
  // process is still the authority (it re-walks the spawn tree and can refuse
  // the whole batch if a turn is running).
  const childCount = useMemo(
    () => threads.filter((t) => t.parentId === thread.id).length,
    [threads, thread.id],
  );

  // Plan 549 (Track B): unarchive -- restores the session to the active
  // list. Symmetric to handleArchive but waits on the store promise so
  // we can surface a failure toast in the future without changing the
  // call site here.
  const handleUnarchive = useCallback(async () => {
    try {
      await unarchiveThread(thread.id);
    } catch (err) {
      console.error('[ThreadListItem] unarchive failed', err);
    }
  }, [unarchiveThread, thread.id]);

  // Plan 506 (A1): export the complete rollout as one portable JSONL file.
  const handleExportRollout = useCallback(async () => {
    try {
      const result = await exportRolloutIPC(thread.id);
      try { await navigator.clipboard.writeText(result.absolutePath); } catch { /* clipboard unavailable */ }
      void showNotification({
        title: t('thread.exportDoneTitle'),
        body: t('thread.exportDoneBody', { lines: result.lines }),
      });
    } catch (err) {
      console.error('rollout export failed:', err);
    }
  }, [thread.id, t]);

  const isPinned = thread.pinned === 1;

  const handleTogglePin = useCallback(() => {
    setThreadPinned(thread.id, !isPinned);
  }, [setThreadPinned, thread.id, isPinned]);

  // Claude parity: the row menu opens the session's working directory in
  // the OS file manager (its "资源管理器" entry). duya's `shell.openPath`
  // is the same affordance for a project folder.
  const handleOpenFolder = useCallback(() => {
    const dir = thread.workingDirectory;
    if (!dir) return;
    void window.electronAPI?.shell?.openPath?.(dir);
  }, [thread.workingDirectory]);

  // Build the menu as MenuActions so the shared DropdownMenu can render it.
  // `className: "thread-dropdown-item"` keeps the legacy item visual
  // (icon-left, danger-tinted delete); the container + divider come from
  // DropdownMenu's own `.sidebar-project-menu*` styles. Pin label flips
  // between "固定" / "取消固定" so the user can read the next action.
  // Plan 549 (Track B): the archive/unarchive row depends on whether
  // the thread is currently archived. We push the active one and skip
  // the other so the user only ever sees the next action.
  //
  // Claude parity (2026-10-22): the item order and the single-key
  // shortcuts follow Claude Code's session menu (固定 P / 重命名 R /
  // 归档 A / 删除 D). The letters are only shown because the row
  // implements them — see the keydown handler on the row itself.
  const isArchived = thread.archivedAt != null;
  const archiveAction: MenuAction = isArchived
    ? {
        kind: "action",
        id: "unarchive",
        label: t("thread.unarchiveThread"),
        iconLeft: <ArchiveIcon size={14} />,
        className: "thread-dropdown-item",
        onSelect: handleUnarchive,
      }
    : {
        kind: "action",
        id: "archive",
        label: t("thread.archiveThread"),
        shortcut: "A",
        iconLeft: <ArchiveIcon size={14} />,
        className: "thread-dropdown-item",
        // Plan 582 (G9): opens the confirm dialog instead of archiving. The
        // backend now takes this session's whole spawn subtree with it, so a
        // bare click is no longer the size of action the label implies.
        onSelect: handleOpenArchiveConfirm,
      };

  const threadMenuItems: MenuAction[] = [
    {
      kind: "action",
      id: "toggle-pin",
      label: isPinned ? t("thread.unpinThread") : t("thread.pinThread"),
      shortcut: "P",
      iconLeft: isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: handleTogglePin,
    },
    {
      kind: "action",
      id: "rename",
      label: t("thread.renameThread"),
      shortcut: "R",
      iconLeft: <NotePencilIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: handleRename,
    },
    {
      kind: "action",
      id: "copy-id",
      label: t("thread.copyThreadId"),
      iconLeft: <CopyIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: handleCopyId,
    },
    ...(thread.workingDirectory
      ? [
          {
            kind: "action" as const,
            id: "open-folder",
            label: t("thread.openFolder"),
            iconLeft: <FolderOpenIcon size={14} />,
            className: "thread-dropdown-item",
            onSelect: handleOpenFolder,
          },
        ]
      : []),
    {
      kind: "action",
      id: "export-rollout",
      label: t("thread.exportRollout"),
      iconLeft: <DownloadSimpleIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: () => void handleExportRollout(),
    },
    { kind: "divider", id: "danger-sep" },
    archiveAction,
    {
      kind: "action",
      id: "delete",
      label: t("thread.deleteThread"),
      shortcut: "D",
      iconLeft: <TrashIcon size={14} />,
      danger: true,
      className: "thread-dropdown-item",
      onSelect: handleDelete,
    },
  ];

  return (
    <>
      <div
        className={`thread-item${isActive ? " active" : ""}${isArchived ? " archived" : ""}`}
        // The session id is the row's stable identity. The TITLE is not: a
        // session's title is derived from its first message, so it changes
        // under the user — and anything that addresses a row by its title
        // breaks the moment a turn lands. A test that wants "that session"
        // needs an attribute that does not move.
        data-session-id={thread.id}
        onClick={handleClick}
        title={thread.title}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          // The row also hosts the rename input. Letters typed there must
          // never reach the row's command switch, or renaming a session to
          // "docs" would delete it on the "d".
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
            return;
          }
          // Claude-style single-key row commands. They only fire while the
          // row itself holds focus (clicked or tabbed to), so typing in the
          // composer is never affected.
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          switch (e.key.toLowerCase()) {
            case "p":
              e.preventDefault();
              handleTogglePin();
              break;
            case "r":
              e.preventDefault();
              handleRename();
              break;
            case "a":
              e.preventDefault();
              handleOpenArchiveConfirm();
              break;
            case "d":
              e.preventDefault();
              handleDelete();
              break;
            default:
              break;
          }
        }}
      >
        {isRenaming ? (
          <input
            ref={inputRef}
            type="text"
            className="thread-item-rename-input"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
              if (e.key === "Escape") handleRenameCancel();
            }}
            onBlur={handleRenameSubmit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="thread-item-title">{displayTitle}</span>
        )}

        {/* Default content (status / time / pinned / archived) stays in flow so
            the title width stays stable. The pin + menu buttons are a sibling
            overlay positioned against the row itself; on hover the default
            content fades out and the buttons fade in over the same area.
            Codex parity (2026-10-22): the session state lives in this trailing
            slot, not in a leading glyph — the title stays flush with the
            group header's left edge. */}
        <div className="thread-item-actions">
          <div className="thread-item-actions-default">
            {/* Claude parity (2026-10-27): the branch / pull-request / merge
                glyphs sit between the title and the state dot, exactly where
                Claude Code puts them. */}
            <SessionWorktreeBadges sessionId={thread.id} workingDirectory={thread.workingDirectory} />
            {/* Codex parity: the trailing state mark. Only non-idle sessions
                get one; `idle` renders nothing so resting rows stay quiet. */}
            {showTrailingStatus && (
              <span
                className={`thread-item-status thread-item-status-${sessionStatus}`}
                role="img"
                aria-label={statusLabel}
                title={statusLabel}
              >
                {sessionStatus === "error" ? (
                  <WarningIcon size={12} />
                ) : sessionStatus === "running" ? (
                  <CircleNotchIcon size={12} className="animate-spin" />
                ) : (
                  <span className="thread-item-status-dot" />
                )}
              </span>
            )}
            {/* Plan 516 — awaiting-input pill wins over pinned / time.
                Reuses the same .bot-contact-status-pill .awaiting-input class
                pair as the bot row so the sidebar visual language stays unified. */}
            {awaitingInput != null ? (
              <span
                className="bot-contact-status-pill awaiting-input"
                title={t(
                  awaitingInput === 'ask'
                    ? 'bot.contactStatus.awaitingAnswer'
                    : awaitingInput === 'auth'
                      ? 'bot.contactStatus.awaitingAuth'
                      : 'bot.contactStatus.awaitingPermission',
                )}
              >
                {t(
                  awaitingInput === 'ask'
                    ? 'bot.contactStatus.awaitingAnswer'
                    : awaitingInput === 'auth'
                      ? 'bot.contactStatus.awaitingAuth'
                      : 'bot.contactStatus.awaitingPermission',
                )}
              </span>
            ) : isArchived ? (
              /* Plan 549 (Track B): archived rows show the archive date
               * in place of the updated time. The CSS class flags the row
               * for the dimmed-stylesheet override so the title text and
               * icon are greyed out at the same time. */
              <span className="thread-item-archived-at" title={t("thread.archivedAt")}>
                {t("thread.archivedAt")} {formatTimeAgo(t, thread.archivedAt ?? Date.now())}
              </span>
            ) : isPinned ? (
              /* Pinned threads show a filled pin icon even when not hovered, so
               * the user can see at a glance which threads are pinned. */
              <PinFilledIcon size={12} className="thread-item-pinned-indicator" />
            ) : (
              <span className="thread-item-time">
                {formatTimeAgo(t, thread.updatedAt)}
              </span>
            )}
          </div>
        </div>

        <div className="thread-item-actions-hover">
          {/* Reference parity (2026-10-22): one button, not a row of icons.
              Hovering a session reveals only the ⋯ 更多 button; every row
              action (pin, rename, copy id, open folder, export, archive,
              delete) lives inside that menu. The menu already carried a
              固定 / 取消固定 entry, so nothing was lost with the old
              hover pin button. */}
          <DropdownMenu
            align="end"
            minWidth={180}
            items={threadMenuItems}
            trigger={
              <button
                type="button"
                className="thread-item-menu-btn"
                aria-label={t('thread.optionsFor', { title: displayTitle })}
                title={t('thread.optionsFor', { title: displayTitle })}
              >
                <DotsThreeIcon size={16} stroke={2.5} />
              </button>
            }
          />
        </div>
      </div>

      {/* Plan 582 (G9): confirm before a subtree-wide archive. Rendered
          outside the row's own clickable surface so the row's "open thread"
          handler does not swallow the dialog's clicks. */}
      <ArchiveConfirm
        open={isArchiveConfirmOpen}
        title={thread.title}
        childCount={childCount}
        onCancel={handleArchiveConfirmCancel}
        onConfirm={async () => {
          setIsArchiveConfirmOpen(false);
          await handleArchive();
        }}
      />
    </>
  );
}
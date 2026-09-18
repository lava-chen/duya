"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { ArchiveIcon, DotsThreeIcon, CopyIcon, NotePencilIcon, CircleNotchIcon, PinIcon, PinFilledIcon, TrashIcon, DownloadSimpleIcon } from "@/components/icons";
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

type TFunc = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface ThreadListItemProps {
  thread: Thread;
  isActive: boolean;
}

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

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
  const [isRenaming, setIsRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(thread.title || "");
  const [isRunning, setIsRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = thread.title || t('thread.newThread');

  // Subscribe to stream phase changes to show running indicator
  useEffect(() => {
    const unsubscribe = subscribeToPhase(thread.id, (phase) => {
      setIsRunning(ACTIVE_PHASES.includes(phase));
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

  // Plan 506 (C2): archive — status flip, rollout files stay on disk.
  const handleArchive = useCallback(() => {
    archiveThread(thread.id);
  }, [archiveThread, thread.id]);

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

  // Build the menu as MenuActions so the shared DropdownMenu can render it.
  // `className: "thread-dropdown-item"` keeps the legacy item visual
  // (icon-left, danger-tinted delete); the container + divider come from
  // DropdownMenu's own `.sidebar-project-menu*` styles. Pin label flips
  // between "固定" / "取消固定" so the user can read the next action.
  // Plan 549 (Track B): the archive/unarchive row depends on whether
  // the thread is currently archived. We push the active one and skip
  // the other so the user only ever sees the next action.
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
        iconLeft: <ArchiveIcon size={14} />,
        className: "thread-dropdown-item",
        onSelect: handleArchive,
      };

  const threadMenuItems: MenuAction[] = [
    {
      kind: "action",
      id: "rename",
      label: t("thread.renameThread"),
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
    {
      kind: "action",
      id: "toggle-pin",
      label: isPinned ? t("thread.unpinThread") : t("thread.pinThread"),
      iconLeft: isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: handleTogglePin,
    },
    {
      kind: "action",
      id: "export-rollout",
      label: t("thread.exportRollout"),
      iconLeft: <DownloadSimpleIcon size={14} />,
      className: "thread-dropdown-item",
      onSelect: () => void handleExportRollout(),
    },
    archiveAction,
    { kind: "divider", id: "delete-sep" },
    {
      kind: "action",
      id: "delete",
      label: t("thread.deleteThread"),
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
        onClick={handleClick}
        title={thread.title}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
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

        {/* Default content (time / running / pinned) stays in flow so the title
            width stays stable. The pin + menu buttons are a sibling overlay
            positioned against the row itself; on hover the default content
            fades out and the buttons fade in over the same area. */}
        <div className="thread-item-actions">
          <div className="thread-item-actions-default">
            {/* Plan 516 — awaiting-input pill wins over running / pinned / time.
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
            ) : isRunning ? (
              <span className="thread-item-running-indicator" title={t('thread.running')}>
                <CircleNotchIcon size={14} stroke={2.5} className="animate-spin" />
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
          {/* Plan 331 Phase 4: quick pin toggle on hover. Pinned threads
           * show a filled icon; unpinned show an outline icon. */}
          <button
            type="button"
            className="thread-item-pin-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleTogglePin();
            }}
            aria-label={isPinned ? t('thread.unpinThread') : t('thread.pinThread')}
            title={isPinned ? t('thread.unpinThread') : t('thread.pinThread')}
          >
            {isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />}
          </button>
          <DropdownMenu
            align="end"
            minWidth={180}
            items={threadMenuItems}
            trigger={
              <button
                type="button"
                className="thread-item-menu-btn"
                aria-label={t('thread.options')}
              >
                <DotsThreeIcon size={16} stroke={2.5} />
              </button>
            }
          />
        </div>
      </div>
    </>
  );
}
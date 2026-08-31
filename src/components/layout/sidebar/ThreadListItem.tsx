"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { ArchiveIcon, DotsThreeIcon, CopyIcon, NotePencilIcon, CircleNotchIcon, PinIcon, PinFilledIcon } from "@/components/icons";
import { subscribeToPhase } from "@/lib/stream-session-manager";
import { useTranslation } from "@/hooks/useTranslation";
import type { StreamPhase } from "@/types/message";
import type { TranslationKey } from "@/i18n";
import { Button } from "@/components/ui/Button";

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
  const { setActiveThread, deleteThread, updateThreadTitle, setThreadPinned } = useConversationStore();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(thread.title || "");
  const [isRunning, setIsRunning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const displayTitle = thread.title || t('thread.newThread');

  // Subscribe to stream phase changes to show running indicator
  useEffect(() => {
    const unsubscribe = subscribeToPhase(thread.id, (phase) => {
      setIsRunning(ACTIVE_PHASES.includes(phase));
    });
    return unsubscribe;
  }, [thread.id]);

  const handleClick = () => {
    if (!showMenu && !isRenaming) {
      setActiveThread(thread.id);
    }
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 160;
    const menuHeight = 120;
    let x = e.clientX;
    let y = e.clientY;

    // Adjust position if menu would go off screen
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }

    setMenuPos({ x, y });
    setShowMenu(true);
  }, []);

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 160;
      const menuHeight = 120;
      let x = rect.right - menuWidth;
      let y = rect.bottom + 4;

      // Adjust position if menu would go off screen
      if (x < 0) {
        x = 8;
      }
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        y = rect.top - menuHeight - 4;
      }

      setMenuPos({ x, y });
    }
    setShowMenu((prev) => !prev);
  }, []);

  const handleRename = useCallback(() => {
    setShowMenu(false);
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
    setShowMenu(false);
    navigator.clipboard.writeText(thread.id);
  }, [thread.id]);

  const handleDelete = useCallback(() => {
    setShowMenu(false);
    deleteThread(thread.id);
  }, [deleteThread, thread.id]);

  const isPinned = thread.pinned === 1;

  const handleTogglePin = useCallback(() => {
    setShowMenu(false);
    setThreadPinned(thread.id, !isPinned);
  }, [setThreadPinned, thread.id, isPinned]);

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  return (
    <>
      <div
        className={`thread-item${isActive ? " active" : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
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
            {isRunning ? (
              <span className="thread-item-running-indicator" title={t('thread.running')}>
                <CircleNotchIcon size={14} stroke={2.5} className="animate-spin" />
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

        <div className={`thread-item-actions-hover${showMenu ? " open" : ""}`}>
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
          <button
            ref={buttonRef}
            type="button"
            className="thread-item-menu-btn"
            onClick={handleMenuClick}
            aria-label={t('thread.options')}
          >
            <DotsThreeIcon size={16} stroke={2.5} />
          </button>
        </div>
      </div>

      {/* Dropdown Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="thread-dropdown-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="thread-dropdown-item"
            onClick={handleRename}
          >
            <NotePencilIcon size={14} />
            <span>{t("thread.renameThread")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="thread-dropdown-item"
            onClick={handleCopyId}
          >
            <CopyIcon size={14} />
            <span>{t("thread.copyThreadId")}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="thread-dropdown-item"
            onClick={handleTogglePin}
          >
            {isPinned ? <PinFilledIcon size={14} /> : <PinIcon size={14} />}
            <span>{isPinned ? t("thread.unpinThread") : t("thread.pinThread")}</span>
          </Button>
          <div className="thread-dropdown-divider" />
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="thread-dropdown-item danger"
            onClick={handleDelete}
          >
            <ArchiveIcon size={14} />
            <span>{t("thread.deleteThread")}</span>
          </Button>
        </div>
      )}
    </>
  );
}

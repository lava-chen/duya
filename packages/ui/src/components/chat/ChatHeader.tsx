// apps/desktop/src/renderer/components/chat/ChatHeader.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DotsThreeIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useOptionalPanel } from "@/hooks/usePanel";

interface ChatHeaderProps {
  thread: Thread;
}

const NOOP_OPEN_PANEL = () => "";

/** The event that asks the chat header to start renaming its title. */
const RENAME_THREAD_EVENT = "duya:rename-thread";

/**
 * macOS keeps the native title bar, so the session actions stay with the
 * chat header there. Everywhere else the window draws its own title bar,
 * and the actions live next to the native window controls.
 */
function hasCustomTitleBar(): boolean {
  if (typeof window === "undefined") return true;
  return window.electronAPI?.versions?.platform !== "darwin";
}

/**
 * The action cluster of the session title bar.
 *
 * It sits in the window's top bar, right next to the native window
 * controls, so the top bar carries the session title and the session
 * actions in one row.
 */
export function ChatHeaderActions() {
  const { t } = useTranslation();
  const currentView = useConversationStore((s) => s.currentView);
  const thread = useConversationStore((s) => {
    const id = s.activeThreadId;
    return id ? s.threads.find((candidate) => candidate.id === id) ?? null : null;
  });
  const setCurrentView = useConversationStore((s) => s.setCurrentView);
  const openOrActivatePage = useOptionalPanel()?.openOrActivatePage ?? NOOP_OPEN_PANEL;

  const handleCopyId = useCallback(() => {
    if (!thread) return;
    navigator.clipboard.writeText(thread.id).catch(() => {});
  }, [thread]);

  const handleCopyTitle = useCallback(() => {
    if (!thread) return;
    navigator.clipboard.writeText(thread.title || "").catch(() => {});
  }, [thread]);

  const menuItems: MenuAction[] = thread
    ? [
        {
          kind: "action",
          id: "rename",
          label: t("thread.renameThread"),
          // Plan 582 (G8): the `Ctrl+Alt+R` / `Ctrl+Alt+S` labels that used to
          // sit here had no keydown handler anywhere in the renderer — grep for
          // `altKey` finds nothing. They advertised shortcuts that did nothing,
          // which is worse than showing none: users bind muscle memory to a key
          // and then conclude the app is broken. Re-add a label only alongside the
          // handler that implements it.
          onSelect: () => {
            window.dispatchEvent(new CustomEvent(RENAME_THREAD_EVENT));
          },
        },
        { kind: "divider", id: "div-1" },
        {
          kind: "action",
          id: "openSideChat",
          label: t("chat.header.openSideChat"),
          onSelect: () => {
            openOrActivatePage("files");
          },
        },
        {
          kind: "submenu",
          id: "copy",
          label: t("chat.header.copy"),
          items: [
            {
              kind: "action",
              id: "copyId",
              label: t("chat.header.copyId"),
              onSelect: handleCopyId,
            },
            {
              kind: "action",
              id: "copyTitle",
              label: t("chat.header.copyTitle"),
              onSelect: handleCopyTitle,
            },
          ],
        },
        {
          kind: "action",
          id: "addAutomation",
          label: t("chat.header.addAutomation"),
          onSelect: () => {
            setCurrentView("automation");
          },
        },
      ]
    : [];

  if (!thread || currentView !== "chat") return null;

  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          className="chat-header-btn chat-header-menu-trigger"
          title={t("chat.header.more")}
          aria-label="More actions"
        >
          <DotsThreeIcon size={16} />
        </button>
      }
      items={menuItems}
    />
  );
}

/**
 * In-content header for the active chat session.
 *
 * Mirrors the IDE-style "open file" tab: thread title (click-to-rename)
 * and the inline project name. The action menu (⋯) lives in the window's
 * top bar next to the window controls.
 */
export function ChatHeader({ thread }: ChatHeaderProps) {
  const { t } = useTranslation();
  const updateThreadTitle = useConversationStore((s) => s.updateThreadTitle);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title || "");

  const inputRef = useRef<HTMLInputElement>(null);

  const projectName = thread.projectName || (thread.workingDirectory
    ? thread.workingDirectory.split(/[\\/]/).pop() || thread.workingDirectory
    : "");

  useEffect(() => {
    if (!isEditing) {
      setDraft(thread.title || "");
    }
  }, [thread.title, isEditing]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // The rename action sits in the window's top bar; it asks the header to
  // start editing through a window event.
  useEffect(() => {
    const handleRename = () => setIsEditing(true);
    window.addEventListener(RENAME_THREAD_EVENT, handleRename);
    return () => window.removeEventListener(RENAME_THREAD_EVENT, handleRename);
  }, []);

  const commitRename = useCallback(() => {
    const next = draft.trim();
    setIsEditing(false);
    if (!next || next === thread.title) {
      setDraft(thread.title || "");
      return;
    }
    void updateThreadTitle(thread.id, next);
  }, [draft, thread.id, thread.title, updateThreadTitle]);

  const cancelRename = useCallback(() => {
    setDraft(thread.title || "");
    setIsEditing(false);
  }, [thread.title]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelRename();
      }
    },
    [commitRename, cancelRename]
  );

  return (
    <div className="chat-header">
      <div className="chat-header-inner">
        <div className="chat-header-title-area">
          {isEditing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleTitleKeyDown}
              className="chat-header-title-input"
              maxLength={120}
              spellCheck={false}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="chat-header-title"
              onClick={() => setIsEditing(true)}
              title={t("thread.renameThread")}
            >
              <span className="chat-header-title-text">
                {thread.title || t("thread.newThread")}
              </span>
            </Button>
          )}

          {projectName && !isEditing && (
            <span className="chat-header-project" title={thread.workingDirectory || projectName}>
              <span className="chat-header-project-text">{projectName}</span>
            </span>
          )}

          {!isEditing && !hasCustomTitleBar() && (
            <div className="chat-header-actions">
              <ChatHeaderActions />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

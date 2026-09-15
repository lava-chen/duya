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

/**
 * In-content header for the active chat session.
 *
 * Mirrors the IDE-style "open file" tab: thread title (click-to-rename),
 * inline project name, and action menu (…). Mounted by ChatView at the
 * top of the chat surface; takes the place of the title that used to live
 * in the OS-level TitleBar.
 */
export function ChatHeader({ thread }: ChatHeaderProps) {
  const { t } = useTranslation();
  const updateThreadTitle = useConversationStore((s) => s.updateThreadTitle);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);
  const openOrActivatePage = useOptionalPanel()?.openOrActivatePage ?? NOOP_OPEN_PANEL;

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

  const handleCopyId = useCallback(() => {
    navigator.clipboard.writeText(thread.id).catch(() => {});
  }, [thread.id]);

  const handleCopyTitle = useCallback(() => {
    navigator.clipboard.writeText(thread.title || "").catch(() => {});
  }, [thread.title]);

  const handleOpenSideChat = useCallback(() => {
    openOrActivatePage("files");
  }, [openOrActivatePage]);

  const handleAddAutomation = useCallback(() => {
    setCurrentView("automation");
  }, [setCurrentView]);

  const menuItems: MenuAction[] = [
    {
      kind: "action",
      id: "rename",
      label: t("thread.renameThread"),
      shortcut: "Ctrl+Alt+R",
      onSelect: () => setIsEditing(true),
    },
    { kind: "divider", id: "div-1" },
    {
      kind: "action",
      id: "openSideChat",
      label: t("chat.header.openSideChat"),
      shortcut: "Ctrl+Alt+S",
      onSelect: handleOpenSideChat,
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
      onSelect: handleAddAutomation,
    },
  ];

  return (
    <div className="chat-header">
      <div className="chat-header-inner">
        <div className="chat-header-title-area">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
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

          {!isEditing && (
            <div className="chat-header-actions">
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

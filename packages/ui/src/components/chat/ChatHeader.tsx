// apps/desktop/src/renderer/components/chat/ChatHeader.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DotsThreeIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { DropdownMenu, type MenuAction } from "@/components/ui/DropdownMenu";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { useOptionalPanel } from "@/hooks/usePanel";
import { PanelLaunchers } from "@/components/layout/panels/PanelLaunchers";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "@/components/layout/task-drawer-store";
import { resolveChatMode } from "@/components/chat/bot/chat-mode";

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
export function hasCustomTitleBar(): boolean {
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
  const taskDrawerOpen = useTaskDrawerOpen();

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
            openOrActivatePage("workspace", { workingDirectory: thread.workingDirectory });
          },
        },
        ...(resolveChatMode(thread.id) === "workspace"
          ? [
              {
                kind: "checkbox" as const,
                id: "taskDrawer",
                label: t("panel.taskList"),
                checked: taskDrawerOpen,
                onToggle: () => setTaskDrawerOpen(!taskDrawerOpen),
              },
            ]
          : []),
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
 * Mirrors the IDE-style "open file" tab: thread title (click-to-rename),
 * the more menu right next to it, and the inline project pill, which opens
 * the folder actions menu. On macOS the action cluster stays next to the
 * native window controls instead (see {@link ChatHeaderActions}).
 */
export function ChatHeader({ thread }: ChatHeaderProps) {
  const { t } = useTranslation();
  const updateThreadTitle = useConversationStore((s) => s.updateThreadTitle);
  const openOrActivatePage = useOptionalPanel()?.openOrActivatePage ?? NOOP_OPEN_PANEL;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title || "");

  const inputRef = useRef<HTMLInputElement>(null);

  const projectName = thread.projectName || (thread.workingDirectory
    ? thread.workingDirectory.split(/[\\/]/).pop() || thread.workingDirectory
    : "");

  const workingDirectory = thread.workingDirectory || "";

  // The project pill opens the same folder actions the reference product
  // shows: reveal the folder, open a terminal on it, copy the path. Items
  // that would need data or IPC the renderer does not have (git remote,
  // changing a live session's working directory) are deliberately absent —
  // a menu entry without a working handler is worse than no entry.
  const projectMenuItems: MenuAction[] = [
    ...(workingDirectory
      ? [
          {
            kind: "action" as const,
            id: "showInExplorer",
            label: t("chat.header.project.showInExplorer"),
            onSelect: () => {
              void window.electronAPI?.shell?.openPath?.(workingDirectory);
            },
          },
          {
            kind: "action" as const,
            id: "openInTerminal",
            label: t("chat.header.project.openInTerminal"),
            onSelect: () => {
              openOrActivatePage("terminal", { cwd: workingDirectory });
            },
          },
        ]
      : []),
    {
      kind: "submenu" as const,
      id: "copy",
      label: t("chat.header.copy"),
      items: [
        ...(workingDirectory
          ? [
              {
                kind: "action" as const,
                id: "copyProjectPath",
                label: t("chat.header.project.copyPath"),
                onSelect: () => {
                  void navigator.clipboard.writeText(workingDirectory);
                },
              },
            ]
          : []),
        {
          kind: "action" as const,
          id: "copyProjectName",
          label: t("chat.header.project.copyName"),
          onSelect: () => {
            void navigator.clipboard.writeText(projectName);
          },
        },
      ],
    },
  ];

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

          {!isEditing && hasCustomTitleBar() && <ChatHeaderActions />}

          {projectName && !isEditing && (
            <DropdownMenu
              trigger={
                <button
                  type="button"
                  className="chat-header-project"
                  title={thread.workingDirectory || projectName}
                >
                  <span className="chat-header-project-text">{projectName}</span>
                </button>
              }
              items={projectMenuItems}
            />
          )}

          {!isEditing && !hasCustomTitleBar() && (
            <div className="chat-header-actions">
              <PanelLaunchers />
              <ChatHeaderActions />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

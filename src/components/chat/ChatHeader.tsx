"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  DotsThreeIcon,
  CaretLeftIcon,
  CaretRightIcon,
} from "@phosphor-icons/react";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { usePanel } from "@/hooks/usePanel";

interface ChatHeaderProps {
  thread: Thread;
}

type MenuAction =
  | { kind: "action"; id: string; label: string; shortcut?: string; onSelect: () => void; danger?: boolean }
  | { kind: "submenu"; id: string; label: string; items: MenuAction[] }
  | { kind: "divider"; id: string };

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
  const { openOrActivatePage, panelOpen, togglePanel } = usePanel();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title || "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);

  const menuRootRef = useRef<HTMLDivElement>(null);
  const menuListRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (!menuOpen) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRootRef.current && !menuRootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setOpenSubmenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen || !menuListRef.current || !triggerRef.current) return;
    const el = menuListRef.current;
    const trigger = triggerRef.current.getBoundingClientRect();
    const pad = 8;
    const gap = 4;

    const menuW = el.offsetWidth || 240;
    const menuH = el.offsetHeight || 200;

    let left = trigger.left;
    let top = trigger.bottom + gap;

    if (left + menuW > window.innerWidth - pad) {
      left = trigger.right - menuW;
    }
    if (left < pad) left = pad;
    if (left + menuW > window.innerWidth - pad) {
      left = window.innerWidth - pad - menuW;
    }

    if (top + menuH > window.innerHeight - pad) {
      top = trigger.top - gap - menuH;
    }
    if (top < pad) top = pad;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [menuOpen, openSubmenu]);

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

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setOpenSubmenu(null);
  }, []);

  const handleCopyId = useCallback(() => {
    navigator.clipboard.writeText(thread.id).catch(() => {});
    closeMenu();
  }, [thread.id, closeMenu]);

  const handleCopyTitle = useCallback(() => {
    navigator.clipboard.writeText(thread.title || "").catch(() => {});
    closeMenu();
  }, [thread.title, closeMenu]);

  const handleOpenSideChat = useCallback(() => {
    openOrActivatePage("files");
    closeMenu();
  }, [openOrActivatePage, closeMenu]);

  const handleAddAutomation = useCallback(() => {
    setCurrentView("automation");
    closeMenu();
  }, [setCurrentView, closeMenu]);

  const menuItems: MenuAction[] = [
    {
      kind: "action",
      id: "rename",
      label: t("thread.renameThread"),
      shortcut: "Ctrl+Alt+R",
      onSelect: () => {
        setIsEditing(true);
        closeMenu();
      },
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
            <button
              type="button"
              className="chat-header-title"
              onClick={() => setIsEditing(true)}
              title={t("thread.renameThread")}
            >
              <span className="chat-header-title-text">
                {thread.title || t("thread.newThread")}
              </span>
            </button>
          )}

          {projectName && !isEditing && (
            <span className="chat-header-project" title={thread.workingDirectory || projectName}>
              <span className="chat-header-project-text">{projectName}</span>
            </span>
          )}

          {!isEditing && (
            <div className="chat-header-actions">
              <div className="chat-header-menu-wrap" ref={menuRootRef}>
                <button
                  ref={triggerRef}
                  type="button"
                  className={`chat-header-btn chat-header-menu-trigger${menuOpen ? " active" : ""}`}
                  onClick={() => setMenuOpen((v) => !v)}
                  title={t("chat.header.more")}
                  aria-label="More actions"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                >
                  <DotsThreeIcon size={16} weight="bold" />
                </button>

                {menuOpen && (
                  <div
                    ref={menuListRef}
                    role="menu"
                    className="chat-header-menu"
                    onMouseLeave={() => setOpenSubmenu(null)}
                  >
                    {menuItems.map((item) => (
                      <MenuItem
                        key={item.id}
                        item={item}
                        openSubmenu={openSubmenu}
                        setOpenSubmenu={setOpenSubmenu}
                        closeMenu={closeMenu}
                      />
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                className={`chat-header-btn chat-header-sidebar-trigger${panelOpen ? " active" : ""}`}
                onClick={togglePanel}
                title={panelOpen ? "收起侧栏" : "打开侧栏"}
                aria-label={panelOpen ? "收起侧栏" : "打开侧栏"}
                aria-pressed={panelOpen}
              >
                <CaretLeftIcon size={14} weight="bold" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface MenuItemProps {
  item: MenuAction;
  openSubmenu: string | null;
  setOpenSubmenu: (id: string | null) => void;
  closeMenu: () => void;
}

function MenuItem({ item, openSubmenu, setOpenSubmenu, closeMenu }: MenuItemProps) {
  if (item.kind === "divider") {
    return <div className="chat-header-menu-divider" role="separator" />;
  }

  if (item.kind === "submenu") {
    const open = openSubmenu === item.id;
    return (
      <div
        className="chat-header-menu-item has-submenu"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={0}
        onMouseEnter={() => setOpenSubmenu(item.id)}
        onClick={() => setOpenSubmenu(open ? null : item.id)}
      >
        <span className="chat-header-menu-label">{item.label}</span>
        <CaretRightIcon size={12} className="chat-header-menu-caret" />
        {open && (
          <div className="chat-header-submenu" role="menu">
            {item.items.map((sub) => (
              <MenuItem
                key={sub.id}
                item={sub}
                openSubmenu={openSubmenu}
                setOpenSubmenu={setOpenSubmenu}
                closeMenu={closeMenu}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      className={`chat-header-menu-item${item.danger ? " danger" : ""}`}
      onClick={item.onSelect}
    >
      <span className="chat-header-menu-label">{item.label}</span>
      {item.shortcut && (
        <span className="chat-header-menu-shortcut">{item.shortcut}</span>
      )}
    </button>
  );
}

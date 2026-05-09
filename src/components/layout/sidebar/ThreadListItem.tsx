"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore, type Thread } from "@/stores/conversation-store";
import { ArchiveIcon, DotsThreeIcon, CopyIcon, NotePencilIcon, CircleNotchIcon, CheckIcon, CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { subscribeToPhase } from "@/lib/stream-session-manager";
import { useTranslation } from "@/hooks/useTranslation";
import type { StreamPhase } from "@/types/message";
import { useSubAgents } from "@/components/chat/SubAgentPanel";

const AGENT_COLORS: Record<string, string> = {
  blue: "var(--accent)",
  orange: "#f97316",
  green: "#22c55e",
  red: "#ef4444",
  purple: "#a855f7",
  cyan: "#06b6d4",
  yellow: "#eab308",
};

function getAgentColor(agentName: string): string {
  let hash = 0;
  for (let i = 0; i < agentName.length; i++) {
    hash = ((hash << 5) - hash) + agentName.charCodeAt(i);
    hash |= 0;
  }
  const colorKeys = Object.keys(AGENT_COLORS);
  return AGENT_COLORS[colorKeys[Math.abs(hash) % colorKeys.length]] || "var(--accent)";
}

interface ThreadListItemProps {
  thread: Thread;
  isActive: boolean;
  childrenThreads?: Thread[];
}

const ACTIVE_PHASES: StreamPhase[] = ["starting", "streaming", "awaiting_permission", "persisting"];

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(diff / 604800000);

  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return `${weeks}w`;
}

export function ThreadListItem({ thread, isActive, childrenThreads = [] }: ThreadListItemProps) {
  const { t } = useTranslation();
  const { setActiveThread, deleteThread, updateThreadTitle, expandedThreads, toggleThreadExpanded } = useConversationStore();
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState(thread.title || "");
  const [isRunning, setIsRunning] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const subAgents = useSubAgents(thread.id);

  const hasChildren = childrenThreads.length > 0;
  const isExpanded = expandedThreads.has(thread.id);

  // Debug logging
  useEffect(() => {
    if (hasChildren) {
      console.log('[ThreadListItem]', thread.id.slice(0, 8), 'hasChildren:', hasChildren, 'childrenCount:', childrenThreads.length, 'isExpanded:', isExpanded);
    }
  }, [hasChildren, childrenThreads.length, isExpanded, thread.id]);

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
        className={`thread-item${isActive ? " active" : ""}${thread.agentType === 'sub-agent' ? " sub-agent" : ""}${hasChildren ? " has-children" : ""}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={thread.title}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        {/* Expand/collapse button for parent threads with children - shown on hover */}
        {hasChildren && (
          <button
            type="button"
            className="thread-item-expand-btn"
            onClick={(e) => { e.stopPropagation(); toggleThreadExpanded(thread.id); }}
          >
            {isExpanded ? <CaretDownIcon size={10} /> : <CaretRightIcon size={10} />}
          </button>
        )}

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
          <>
            {thread.agentType === 'sub-agent' && thread.agentName && (
              <span className="sub-agent-dot" style={{ color: getAgentColor(thread.agentName) }}>●</span>
            )}
            <span className="thread-item-title">{thread.title || "New Thread"}</span>
          </>
        )}

        {/* Sub-agent badge or Running indicator, Time, or Three dots menu button */}
        {subAgents.length > 0 && !isHovered && !showMenu ? (
          <SubAgentBadges agents={subAgents} isRunning={isRunning} />
        ) : isRunning ? (
          <span className="thread-item-running-indicator" title="Agent is running...">
            <CircleNotchIcon size={14} weight="bold" className="animate-spin" />
          </span>
        ) : isHovered || showMenu ? (
          <button
            ref={buttonRef}
            type="button"
            className="thread-item-menu-btn"
            onClick={handleMenuClick}
            aria-label="Thread options"
          >
            <DotsThreeIcon size={16} weight="bold" />
          </button>
        ) : (
          <span className="thread-item-time">
            {formatTimeAgo(thread.updatedAt)}
          </span>
        )}
      </div>

      {/* Render child sub-agent threads */}
      {hasChildren && isExpanded && (
        <div className="thread-item-children">
          {childrenThreads.map((child) => (
            <ChildThreadListItem
              key={child.id}
              thread={child}
            />
          ))}
        </div>
      )}

      {/* Dropdown Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="thread-dropdown-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <button
            type="button"
            className="thread-dropdown-item"
            onClick={handleRename}
          >
            <NotePencilIcon size={14} />
            <span>{t("thread.renameThread")}</span>
          </button>
          <button
            type="button"
            className="thread-dropdown-item"
            onClick={handleCopyId}
          >
            <CopyIcon size={14} />
            <span>{t("thread.copyThreadId")}</span>
          </button>
          <div className="thread-dropdown-divider" />
          <button
            type="button"
            className="thread-dropdown-item danger"
            onClick={handleDelete}
          >
            <ArchiveIcon size={14} />
            <span>{t("thread.deleteThread")}</span>
          </button>
        </div>
      )}
    </>
  );
}

// Child thread item wrapper that gets active state from store
function ChildThreadListItem({ thread }: { thread: Thread }) {
  const { activeThreadId } = useConversationStore();
  return (
    <ThreadListItem
      thread={thread}
      isActive={thread.id === activeThreadId}
    />
  );
}

interface SubAgentBadgesProps {
  agents: import("@/components/chat/SubAgentPanel").SubAgentInfo[];
  isRunning: boolean;
}

function SubAgentBadges({ agents, isRunning }: SubAgentBadgesProps) {
  const displayAgent = agents[0];
  const runningAgents = agents.filter((a) => a.status === 'running');
  const hasCompleted = agents.some((a) => a.status === 'completed');

  if (!displayAgent) return null;

  return (
    <div className="thread-item-sub-agent-badges">
      <span
        className="thread-item-sub-agent-name"
        style={{ color: displayAgent.color }}
      >
        {displayAgent.name}
      </span>
      {isRunning || runningAgents.length > 0 ? (
        <CircleNotchIcon size={12} weight="bold" className="animate-spin text-muted-foreground" />
      ) : hasCompleted ? (
        <CheckIcon size={12} weight="bold" className="text-green-500" />
      ) : null}
    </div>
  );
}

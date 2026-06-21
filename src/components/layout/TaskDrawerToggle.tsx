"use client";

import { CheckSquareIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { usePanel } from "@/hooks/usePanel";
import { useTaskCount } from "@/hooks/useTaskCount";
import { useConversationStore } from "@/stores/conversation-store";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "./task-drawer-store";

export function TaskDrawerToggle() {
  const { panelOpen, panelWidth, workspaceExpanded } = usePanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const currentView = useConversationStore((state) => state.currentView);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { pending, active } = useTaskCount();
  const taskBadgeCount = pending + active;

  useEffect(() => {
    if (workspaceExpanded && taskDrawerOpen) {
      setTaskDrawerOpen(false);
    }
  }, [taskDrawerOpen, workspaceExpanded]);

  if (currentView !== "chat" || !activeThreadId || workspaceExpanded) return null;

  const position = {
    right: panelOpen
      ? `min(${panelWidth + 8}px, calc(100% - 40px))`
      : 54,
  };

  return (
    <button
      type="button"
      className={`workspace-task-toggle${taskDrawerOpen ? " active" : ""}`}
      style={position}
      onClick={() => setTaskDrawerOpen(!taskDrawerOpen)}
      title="任务列表"
      aria-label="任务列表"
      aria-pressed={taskDrawerOpen}
      data-testid="task-card-trigger"
    >
      <CheckSquareIcon size={16} weight="regular" />
      {taskBadgeCount > 0 && (
        <span className="panel-task-toggle-badge">
          {taskBadgeCount > 99 ? "99+" : taskBadgeCount}
        </span>
      )}
    </button>
  );
}

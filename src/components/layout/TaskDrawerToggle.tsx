"use client";

import { CheckSquareIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { usePanel } from "@/hooks/usePanel";
import { useTaskCount } from "@/hooks/useTaskCount";
import { useSubAgentProgress } from "@/hooks/useSubAgentProgress";
import { useConversationStore } from "@/stores/conversation-store";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "./task-drawer-store";
import { useTranslation } from "@/hooks/useTranslation";

export function TaskDrawerToggle() {
  const { t } = useTranslation();
  const { panelOpen, panelWidth, workspaceExpanded } = usePanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const currentView = useConversationStore((state) => state.currentView);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { pending, active } = useTaskCount();
  const agents = useSubAgentProgress(activeThreadId ?? "");
  const runningAgents = agents.filter((agent) => agent.status === "running" || agent.status === "waiting").length;
  const taskBadgeCount = pending + active + runningAgents;

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
      title={t('panel.taskList')}
      aria-label={t('panel.taskList')}
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

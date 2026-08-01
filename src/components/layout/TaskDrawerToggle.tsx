"use client";

import { InfoIcon } from "@/components/icons";
import { useEffect } from "react";
import { usePanel } from "@/hooks/usePanel";
import { useBashTasks } from "@/hooks/useBashTasks";
import { useConversationStore } from "@/stores/conversation-store";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "./task-drawer-store";
import { useTranslation } from "@/hooks/useTranslation";

export function TaskDrawerToggle() {
  const { t } = useTranslation();
  const { panelOpen, panelWidth, workspaceExpanded } = usePanel();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const currentView = useConversationStore((state) => state.currentView);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { runningCount: runningBashCount } = useBashTasks(activeThreadId ?? "");

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
      className={`workspace-task-toggle${taskDrawerOpen ? " active" : ""}${runningBashCount > 0 ? " has-background-tasks" : ""}`}
      style={position}
      onClick={() => setTaskDrawerOpen(!taskDrawerOpen)}
      title={
        runningBashCount > 0
          ? t('panel.taskList') + ` · ${runningBashCount} background command${runningBashCount > 1 ? 's' : ''} running`
          : t('panel.taskList')
      }
      aria-label={t('panel.taskList')}
      aria-pressed={taskDrawerOpen}
      data-testid="task-card-trigger"
    >
      <InfoIcon size={16} />
    </button>
  );
}

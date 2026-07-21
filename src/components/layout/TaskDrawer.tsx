"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CaretRightIcon,
  CheckIcon,
  CircleIcon,
  ClockCounterClockwiseIcon,
  SpinnerIcon,
  TrashIcon,
  ArrowCounterClockwiseIcon,
  RobotIcon,
  XIcon,
} from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { useSubAgentProgress, type SubAgentRowInfo } from "@/hooks/useSubAgentProgress";
import { useTranslation } from "@/hooks/useTranslation";
import { setTaskDrawerOpen, useTaskDrawerOpen } from "./task-drawer-store";
import { useRecap, clearRecap } from "./recap-store";

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

const statusIcons: Record<Task["status"], React.ReactNode> = {
  pending: <CircleIcon size={12} className="text-muted-foreground/45" />,
  in_progress: <SpinnerIcon size={12} className="text-accent animate-spin" />,
  completed: <CheckIcon size={12} className="text-green-500" />,
};

const statusColors: Record<Task["status"], string> = {
  pending: "text-muted-foreground/85",
  in_progress: "text-foreground font-medium",
  completed: "text-muted-foreground/45 line-through",
};

const POLL_INTERVAL_MS = 1000;

export function useTaskList(threadId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    if (!threadId) {
      setTasks([]);
      return;
    }

    setLoading(true);
    try {
      const raw = await window.electronAPI?.thread?.getTasks?.(threadId);
      if (raw) {
        const parsed = (raw as Task[]).map((task) => ({
          ...task,
          blocks: task.blocks || [],
          blockedBy: task.blockedBy || [],
        }));
        setTasks(parsed);
      } else {
        setTasks([]);
      }
    } catch (err) {
      console.error("[TaskDrawer] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    setTasks([]);
    void fetchTasks();
  }, [threadId, fetchTasks]);

  return { tasks, setTasks, loading, fetchTasks };
}

export function TaskDrawer() {
  const { t } = useTranslation();
  const open = useTaskDrawerOpen();
  const onClose = useCallback(() => setTaskDrawerOpen(false), []);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const { tasks, setTasks, loading, fetchTasks } = useTaskList(open ? activeThreadId : null);
  const agents = useSubAgentProgress(activeThreadId ?? "");
  const recap = useRecap();

  const [collapsed, setCollapsed] = useState(false);

  // Recap auto-dismiss: 10s after arrival, clear the store so the block
  // disappears. Re-arms whenever a new recap arrives (receivedAt change).
  useEffect(() => {
    if (!recap.text || !recap.receivedAt) return;
    const timer = setTimeout(() => {
      clearRecap();
    }, 10000);
    return () => clearTimeout(timer);
  }, [recap.text, recap.receivedAt]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => {
      void fetchTasks();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, fetchTasks]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleToggleStatus = useCallback(
    async (task: Task) => {
      const next = task.status === "completed" ? "pending" : "completed";
      setTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, status: next } : item))
      );

      try {
        await window.electronAPI?.thread?.updateTask?.(task.id, { status: next });
        void fetchTasks();
      } catch (err) {
        console.error("[TaskDrawer] updateTask failed:", err);
        setTasks((prev) =>
          prev.map((item) => (item.id === task.id ? { ...item, status: task.status } : item))
        );
      }
    },
    [fetchTasks, setTasks]
  );

  const handleDelete = useCallback(
    async (task: Task) => {
      setTasks((prev) => prev.filter((item) => item.id !== task.id));
      try {
        await window.electronAPI?.thread?.deleteTask?.(task.id);
      } catch (err) {
        console.error("[TaskDrawer] deleteTask failed:", err);
        void fetchTasks();
      }
    },
    [fetchTasks, setTasks]
  );

  const completed = tasks.filter((task) => task.status === "completed").length;
  const pending = tasks.length - completed;
  const runningAgents = agents.filter((agent) => agent.status === "running" || agent.status === "waiting").length;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="task-card-rail"
          className="task-card-rail"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          <motion.aside
            initial={{ opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 14 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="task-card-shell"
            role="dialog"
            aria-label={t('taskDrawer.ariaLabel')}
            data-testid="task-card"
          >
            <DrawerHeader
              pending={pending}
              completed={completed}
              runningAgents={runningAgents}
              totalAgents={agents.length}
              collapsed={collapsed}
              onToggleCollapsed={() => setCollapsed((value) => !value)}
              onClose={onClose}
            />

            {recap.text && (
              <RecapBlock
                text={recap.text}
                onDismiss={() => clearRecap()}
              />
            )}

            <div className="task-card-list">
              {!collapsed && (
                <div className="task-card-list-inner">
                  {agents.length > 0 && (
                    <TaskDrawerSection label={t('taskDrawer.agents')}>
                      {agents.map((agent) => (
                        <AgentRow
                          key={agent.id}
                          agent={agent}
                          onOpen={() => {
                            if (agent.sessionId) {
                              useConversationStore.getState().setActiveThread(agent.sessionId);
                            }
                          }}
                        />
                      ))}
                    </TaskDrawerSection>
                  )}
                  <TaskDrawerSection label={t('taskDrawer.tasks')}>
                  {tasks.length === 0 && !loading && (
                    <div className="task-card-empty">{t('taskDrawer.empty')}</div>
                  )}
                  {tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      onToggleStatus={() => void handleToggleStatus(task)}
                      onDelete={() => void handleDelete(task)}
                    />
                  ))}
                  </TaskDrawerSection>
                </div>
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DrawerHeader({
  pending,
  completed,
  runningAgents,
  totalAgents,
  collapsed,
  onToggleCollapsed,
  onClose,
}: {
  pending: number;
  completed: number;
  runningAgents: number;
  totalAgents: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="task-card-header">
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="task-card-title"
        aria-expanded={!collapsed}
      >
        <CaretRightIcon
          size={11}
          className={`task-card-title-caret${collapsed ? "" : " open"}`}
        />
        <span className="task-card-title-text">{t('taskDrawer.title')}</span>
        <span className="task-card-count">{t('taskDrawer.openCount', { count: pending })}</span>
        {totalAgents > 0 && (
          <span className="task-card-agent-count">
            {runningAgents > 0
              ? t('taskDrawer.runningAgents', { count: runningAgents })
              : t('taskDrawer.totalAgents', { count: totalAgents })}
          </span>
        )}
        {completed > 0 && <span className="task-card-done-count">{t('taskDrawer.doneCount', { count: completed })}</span>}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="task-card-icon-button"
        title={t('taskDrawer.close')}
        aria-label={t('taskDrawer.close')}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

function TaskDrawerSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="task-card-section">
      <div className="task-card-section-label">{label}</div>
      {children}
    </section>
  );
}

function AgentRow({ agent, onOpen }: { agent: SubAgentRowInfo; onOpen: () => void }) {
  const canOpen = Boolean(agent.sessionId);
  const statusIcon = agent.status === "running" || agent.status === "waiting"
    ? <SpinnerIcon size={12} className="text-accent animate-spin" />
    : agent.status === "completed"
      ? <CheckIcon size={12} className="text-green-500" />
      : <XIcon size={12} className="text-red-500" />;

  return (
    <button
      type="button"
      className="task-card-agent-row"
      onClick={onOpen}
      disabled={!canOpen}
      title={canOpen ? t('taskDrawer.openAgent', { name: agent.name }) : t('taskDrawer.agentStarting', { name: agent.name })}
    >
      <span className="task-card-agent-icon" style={{ color: agent.color }}>
        <RobotIcon size={13} />
      </span>
      <span className="task-card-row-title">{agent.name}</span>
      <span className="task-card-agent-status">{agent.description}</span>
      <span className="task-card-agent-state">{statusIcon}</span>
    </button>
  );
}

function TaskRow({
  task,
  onToggleStatus,
  onDelete,
}: {
  task: Task;
  onToggleStatus: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isCompleted = task.status === "completed";
  return (
    <div className="task-card-row group" title={task.description}>
      <button
        type="button"
        onClick={onToggleStatus}
        className="task-card-status"
        title={isCompleted ? t('taskDrawer.reopen') : t('taskDrawer.markDone')}
        aria-label={isCompleted ? t('taskDrawer.reopenTask') : t('taskDrawer.markTaskDone')}
      >
        {statusIcons[task.status]}
      </button>
      <span className={`task-card-row-title ${statusColors[task.status]}`}>
        {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
      </span>
      {task.owner && task.status !== "completed" && (
        <span className="task-card-row-meta">{task.owner}</span>
      )}
      {task.blockedBy.length > 0 && (
        <span className="task-card-row-blocked">{t('taskDrawer.blocked')}</span>
      )}
      <div className="task-card-row-actions">
        {isCompleted ? (
          <button
            type="button"
            onClick={onToggleStatus}
            className="task-card-row-action"
            title={t('taskDrawer.reopen')}
            aria-label={t('taskDrawer.reopenTask')}
          >
            <ArrowCounterClockwiseIcon size={11} />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDelete}
          className="task-card-row-action danger"
          title={t('taskDrawer.delete')}
          aria-label={t('taskDrawer.delete')}
        >
          <TrashIcon size={11} />
        </button>
      </div>
    </div>
  );
}

function RecapBlock({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="task-card-recap">
      <ClockCounterClockwiseIcon
        size={12}
        className="task-card-recap-icon shrink-0"
      />
      <div className="task-card-recap-text" title={text}>
        {text}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="task-card-recap-close"
        title={t('taskDrawer.dismissRecap')}
        aria-label={t('taskDrawer.dismissRecap')}
      >
        <XIcon size={11} />
      </button>
    </div>
  );
}

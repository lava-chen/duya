// src/components/layout/TaskDrawer.tsx
// Right-edge task rail container. Owns:
//   - visibility / keyboard (Escape) / 1s polling
//   - task list state via useTaskList + mutation handlers (optimistic
//     update + rollback)
//   - sub-agent data (live SSE via useSubAgentProgress)
//   - assembly of the header, agents section and task list section
//
// Sub-panels live in their own files:
//   ./TaskDrawerHeader.tsx   — header bar with counters
//   ./AgentListSection.tsx   — sub-agent rows + session jump
//   ./TaskListSection.tsx    — task rows + status icons
//   ./DrawerSection.tsx      — generic labelled section wrapper

'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useConversationStore } from '@/stores/conversation-store';
import { useSubAgentProgress } from '@/hooks/useSubAgentProgress';
import { useTaskList } from '@/hooks/useTaskList';
import { setTaskDrawerOpen, useTaskDrawerOpen } from './task-drawer-store';
import { TaskDrawerHeader } from './TaskDrawerHeader';
import { AgentListSection } from './AgentListSection';
import { TaskListSection } from './TaskListSection';

const POLL_INTERVAL_MS = 1000;

export function TaskDrawer() {
  const open = useTaskDrawerOpen();
  const onClose = useCallback(() => setTaskDrawerOpen(false), []);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const { tasks, setTasks, loading, fetchTasks } = useTaskList(open ? activeThreadId : null);
  const agents = useSubAgentProgress(activeThreadId ?? "");

  const [collapsed, setCollapsed] = useState(false);

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
    async (task: typeof tasks[number]) => {
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
    async (task: typeof tasks[number]) => {
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
  const runningAgents = agents.filter(
    (agent) => agent.status === "running" || agent.status === "waiting"
  ).length;

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
            aria-label="Task list"
            data-testid="task-card"
          >
            <TaskDrawerHeader
              pending={pending}
              completed={completed}
              runningAgents={runningAgents}
              totalAgents={agents.length}
              collapsed={collapsed}
              onToggleCollapsed={() => setCollapsed((value) => !value)}
              onClose={onClose}
            />

            <div className="task-card-list">
              {!collapsed && (
                <div className="task-card-list-inner">
                  <AgentListSection
                    agents={agents}
                    onOpen={(sessionId) =>
                      useConversationStore.getState().setActiveThread(sessionId)
                    }
                  />
                  <TaskListSection
                    tasks={tasks}
                    loading={loading}
                    onToggleStatus={handleToggleStatus}
                    onDelete={handleDelete}
                  />
                </div>
              )}
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
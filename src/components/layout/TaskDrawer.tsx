// src/components/layout/TaskDrawer.tsx
// Right-edge session-detail rail. Owns:
//   - visibility / keyboard (Escape) / 1s polling
//   - task list state via useTaskList + mutation handlers (optimistic
//     update + rollback)
//   - sub-agent data (live SSE via useSubAgentProgress)
//   - session-derived data: file changes / artifacts / sources
//   - assembly of 6 section components (no header — the panel starts
//     straight at EnvironmentInfoSection)
//
// Sub-panels live in their own files:
//   ./EnvironmentInfoSection.tsx — session metadata + git-style totals
//   ./MainAgentSection.tsx       — main-agent profile dropdown
//   ./SubAgentListSection.tsx    — sub-agent rows + session jump
//   ./TaskListSection.tsx        — task rows + status icons
//   ./SourcesSection.tsx         — attachments / browser URLs / other refs
//   ./ArtifactsSection.tsx       — files created by the agent
//   ./DrawerSection.tsx          — generic labelled section wrapper

'use client';

import { useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useConversationStore } from '@/stores/conversation-store';
import { useSubAgentProgress } from '@/hooks/useSubAgentProgress';
import { useTaskList } from '@/hooks/useTaskList';
import { useSessionArtifacts } from '@/hooks/useSessionArtifacts';
import { useSessionSources } from '@/hooks/useSessionSources';
import { setTaskDrawerOpen, useTaskDrawerOpen } from './task-drawer-store';
import { EnvironmentInfoSection } from './EnvironmentInfoSection';
import { MainAgentSection } from './MainAgentSection';
import { SubAgentListSection } from './SubAgentListSection';
import { TaskListSection } from './TaskListSection';
import { SourcesSection } from './SourcesSection';
import { ArtifactsSection } from './ArtifactsSection';

const POLL_INTERVAL_MS = 1000;

export function TaskDrawer() {
  const open = useTaskDrawerOpen();
  const onClose = useCallback(() => setTaskDrawerOpen(false), []);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const threads = useConversationStore((state) => state.threads);
  const thread = threads.find((t) => t.id === activeThreadId) ?? null;

  const { tasks, setTasks, loading, fetchTasks } = useTaskList(open ? activeThreadId : null);
  const agents = useSubAgentProgress(activeThreadId ?? "");
  const { fileChanges, artifacts } = useSessionArtifacts(open ? activeThreadId : null);
  const sources = useSessionSources(open ? activeThreadId : null);

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
            aria-label="Session details"
            data-testid="task-card"
          >
            <div className="task-card-list">
              <div className="task-card-list-inner">
                <EnvironmentInfoSection
                  title={thread?.title ?? ''}
                  workingDirectory={thread?.workingDirectory ?? null}
                  model={thread?.model ?? null}
                  fileChanges={fileChanges}
                />

                <MainAgentSection
                  sessionId={activeThreadId}
                  currentProfileId={thread?.agentProfileId ?? null}
                />

                <SubAgentListSection
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

                <SourcesSection
                  userAttachments={sources.userAttachments}
                  browserUrls={sources.browserUrls}
                  others={sources.others}
                />

                <ArtifactsSection
                  artifacts={artifacts}
                  cwd={thread?.workingDirectory ?? null}
                />
              </div>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
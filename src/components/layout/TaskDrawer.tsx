// src/components/layout/TaskDrawer.tsx
// Right-edge session-detail rail. Owns:
//   - visibility / keyboard (Escape)
//   - sub-agent data (live SSE via useSubAgentProgress)
//   - session-derived data: git status / artifacts / sources
//   - assembly of 4 section components (no header — the panel starts
//     straight at EnvironmentInfoSection)
//
// Sub-panels live in their own files:
//   ./EnvironmentInfoSection.tsx — git-changes row (returns null when not git)
//   ./AgentListSection.tsx       — sub-agent rows + session jump
//   ./SourcesSection.tsx         — attachments / browser URLs / other refs
//   ./ArtifactsSection.tsx       — files created by the agent
//   ./DrawerSection.tsx          — generic labelled section wrapper

'use client';

import { useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useConversationStore } from '@/stores/conversation-store';
import { useSubAgentProgress } from '@/hooks/useSubAgentProgress';
import { useSessionArtifacts } from '@/hooks/useSessionArtifacts';
import { useSessionSources } from '@/hooks/useSessionSources';
import { useGitStatus } from '@/hooks/useGitStatus';
import { useBashTasks } from '@/hooks/useBashTasks';
import { setTaskDrawerOpen, useTaskDrawerOpen } from './task-drawer-store';
import { EnvironmentInfoSection } from './EnvironmentInfoSection';
import { AgentListSection } from './AgentListSection';
import { BashTaskSection } from './BashTaskSection';
import { SourcesSection } from './SourcesSection';
import { ArtifactsSection } from './ArtifactsSection';

export function TaskDrawer() {
  const open = useTaskDrawerOpen();
  const onClose = useCallback(() => setTaskDrawerOpen(false), []);
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  const threads = useConversationStore((state) => state.threads);
  const thread = threads.find((t) => t.id === activeThreadId) ?? null;

  const agents = useSubAgentProgress(activeThreadId ?? "");
  const { tasks: bashTasks } = useBashTasks(open ? activeThreadId : null);
  const { artifacts } = useSessionArtifacts(open ? activeThreadId : null);
  const sources = useSessionSources(open ? activeThreadId : null);
  const gitStatus = useGitStatus(thread?.workingDirectory ?? null, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
                <EnvironmentInfoSection gitStatus={gitStatus} />

                <AgentListSection
                  agents={agents}
                  onOpen={(sessionId) =>
                    useConversationStore.getState().setActiveThread(sessionId)
                  }
                />

                <BashTaskSection tasks={bashTasks} />

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
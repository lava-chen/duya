// src/components/layout/AgentListSection.tsx
// Renders the Sub-agents section inside the TaskDrawer: a list of
// running sub-agent rows spawned by the main agent. Each row can be
// clicked to jump into the sub-agent's session via the
// container-provided onOpen callback.

'use client';

import {
  CheckIcon,
  RobotIcon,
  SpinnerIcon,
  XIcon,
} from '@/components/icons';
import type { SubAgentRowInfo } from '@/hooks/useSubAgentProgress';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import { DrawerSection } from './DrawerSection';

const STATUS_KEY: Record<SubAgentRowInfo['status'], TranslationKey> = {
  waiting: 'subAgent.status.waiting',
  running: 'subAgent.status.running',
  completed: 'subAgent.status.completed',
  error: 'subAgent.status.error',
};

export interface AgentListSectionProps {
  agents: SubAgentRowInfo[];
  /**
   * Called with the sub-agent's session id (and the row itself, so the host
   * can label the destination). Opens the sub-agent's session — the TaskDrawer
   * routes this to the sidebar session panel (ZCode-parity side pane).
   */
  onOpen: (sessionId: string, agent: SubAgentRowInfo) => void;
}

export function AgentListSection({ agents, onOpen }: AgentListSectionProps) {
  if (agents.length === 0) return null;

  return (
    <DrawerSection label="Sub-agents">
      {agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          onOpen={() => {
            if (agent.sessionId) onOpen(agent.sessionId, agent);
          }}
        />
      ))}
    </DrawerSection>
  );
}

function AgentRow({ agent, onOpen }: { agent: SubAgentRowInfo; onOpen: () => void }) {
  const canOpen = Boolean(agent.sessionId);
  const { t } = useTranslation();
  const statusIcon =
    agent.status === "running" || agent.status === "waiting" ? (
      <SpinnerIcon size={12} className="text-accent animate-spin" />
    ) : agent.status === "completed" ? (
      <CheckIcon size={12} className="text-green-500" />
    ) : (
      <XIcon size={12} className="text-red-500" />
    );

  return (
    <button
      type="button"
      className="task-card-agent-row"
      onClick={onOpen}
      disabled={!canOpen}
      title={canOpen ? `Open ${agent.name}` : `${agent.name} is starting`}
    >
      <span className="task-card-agent-icon" style={{ color: agent.color }}>
        <RobotIcon size={13} />
      </span>
      <span className="task-card-row-title">{agent.name}</span>
      <span className="task-card-agent-status">{t(STATUS_KEY[agent.status])}</span>
      <span className="task-card-agent-state">{statusIcon}</span>
    </button>
  );
}
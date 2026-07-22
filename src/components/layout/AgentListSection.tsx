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
import { DrawerSection } from './DrawerSection';

export interface AgentListSectionProps {
  agents: SubAgentRowInfo[];
  onOpen: (sessionId: string) => void;
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
            if (agent.sessionId) onOpen(agent.sessionId);
          }}
        />
      ))}
    </DrawerSection>
  );
}

function AgentRow({ agent, onOpen }: { agent: SubAgentRowInfo; onOpen: () => void }) {
  const canOpen = Boolean(agent.sessionId);
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
      <span className="task-card-agent-status">{agent.description}</span>
      <span className="task-card-agent-state">{statusIcon}</span>
    </button>
  );
}
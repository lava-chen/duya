'use client';

import { useMemo } from 'react';
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import type { StreamPhase } from '@/types';

export interface SubAgentRowInfo {
  id: string;
  name: string;
  color: string;
  status: 'waiting' | 'running' | 'completed' | 'error';
  description?: string;
  eventCount?: number;
  sessionId?: string;
  outputFilePath?: string;
}

const AGENT_NAME_COLORS = [
  { name: 'Archimedes', color: '#3b82f6' },
  { name: 'Avicenna', color: '#f97316' },
  { name: 'Galileo', color: '#22c55e' },
  { name: 'Maxwell', color: '#ef4444' },
  { name: 'Newton', color: '#a855f7' },
  { name: 'Euler', color: '#06b6d4' },
  { name: 'Turing', color: '#ec4899' },
  { name: 'Curie', color: '#14b8a6' },
  { name: 'Darwin', color: '#f59e0b' },
  { name: 'Einstein', color: '#6366f1' },
];

function getAgentColor(index: number): string {
  return AGENT_NAME_COLORS[index % AGENT_NAME_COLORS.length].color;
}

function getAgentName(index: number): string {
  return AGENT_NAME_COLORS[index % AGENT_NAME_COLORS.length].name;
}

function groupEventsByAgent(events: AgentProgressEventWithMeta[]): Map<string, AgentProgressEventWithMeta[]> {
  const groups = new Map<string, AgentProgressEventWithMeta[]>();
  for (const event of events) {
    const key = event.agentId || 'legacy-agent';
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(event);
  }
  return groups;
}

function getAgentStatus(events: AgentProgressEventWithMeta[], phase: StreamPhase): SubAgentRowInfo['status'] {
  if (events.length === 0) return 'waiting';
  const lastEvent = events[events.length - 1];
  if (lastEvent.type === 'done') return 'completed';
  if (lastEvent.type === 'error') return 'error';
  const streamInactive = phase === 'completed' || phase === 'error' || phase === 'idle';
  if (streamInactive) {
    return 'completed';
  }
  return 'running';
}

function getAgentDisplayNameFromEvents(events: AgentProgressEventWithMeta[]): string {
  const metaEvent = [...events].reverse().find((e) => e.agentType || e.agentName || e.agentDescription);
  if (metaEvent?.agentName) return metaEvent.agentName;
  if (metaEvent?.agentType) {
    const type = metaEvent.agentType
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim();
    return type
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  if (metaEvent?.agentDescription) return metaEvent.agentDescription;
  return '';
}

/**
 * Hook that reads sub-agent progress from the SSE agent_progress channel.
 * In the canonical architecture (after migration), subagent_info content blocks
 * from the message history are the primary data source. During the migration
 * period, this hook continues to use the SSE channel for live updates.
 */
export function useSubAgentProgress(sessionId: string): SubAgentRowInfo[] {
  const events = useStreamingAgentProgress(sessionId);
  const phase = useStreamPhase(sessionId);

  return useMemo(() => {
    const groups = groupEventsByAgent(events);
    const agents: SubAgentRowInfo[] = [];
    let index = 0;

    for (const [agentId, agentEvents] of groups) {
      const customName = getAgentDisplayNameFromEvents(agentEvents);
      const status = getAgentStatus(agentEvents, phase);
      const isTerminal = status === 'completed' || status === 'error';
      // AgentProgressEvent carries the sub-agent's session under `sessionId`
      // (it is the canonical sub-agent session id, distinct from the parent
      // session that emitted the progress event).
      const dbSessionId = agentEvents.find(e => e.sessionId)?.sessionId;

      agents.push({
        id: agentId,
        name: customName || getAgentName(index),
        color: getAgentColor(index),
        status,
        description: isTerminal
          ? status === 'completed'
            ? '已完成'
            : '出错'
          : '正在运行...',
        eventCount: agentEvents.length,
        sessionId: dbSessionId,
        // outputFilePath will be available from subagent_info blocks in the
        // canonical architecture; during migration this is empty.
        outputFilePath: undefined,
      });
      index++;
    }

    return agents;
  }, [events, phase]);
}
'use client';

import { useMemo } from 'react';
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { colorForAgent } from '@/lib/agent-color';

export interface SubAgentRowInfo {
  id: string;
  name: string;
  color: string;
  status: 'waiting' | 'running' | 'completed' | 'error';
  eventCount?: number;
  sessionId?: string;
  outputFilePath?: string;
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

export function getSubAgentStatus(events: AgentProgressEventWithMeta[]): SubAgentRowInfo['status'] {
  if (events.length === 0) return 'waiting';
  const lastEvent = events[events.length - 1];
  if (lastEvent.type === 'done') return 'completed';
  if (lastEvent.type === 'error') return 'error';
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

  return useMemo(() => {
    const groups = groupEventsByAgent(events);
    const agents: SubAgentRowInfo[] = [];

    for (const [agentId, agentEvents] of groups) {
      const customName = getAgentDisplayNameFromEvents(agentEvents);
      const status = getSubAgentStatus(agentEvents);
      const isTerminal = status === 'completed' || status === 'error';
      // AgentProgressEvent carries the sub-agent's session under `sessionId`
      // (it is the canonical sub-agent session id, distinct from the parent
      // session that emitted the progress event).
      const dbSessionId = agentEvents.find(e => e.sessionId)?.sessionId;

      agents.push({
        id: agentId,
        name: customName || 'SubAgent',
        // Hash by agentId so a sub-agent keeps its color across remounts,
        // reconnects, and concurrent spawns regardless of event order.
        color: colorForAgent(agentId),
        status,
        eventCount: agentEvents.length,
        sessionId: dbSessionId,
        // outputFilePath will be available from subagent_info blocks in the
        // canonical architecture; during migration this is empty.
        outputFilePath: undefined,
      });
    }

    return agents;
  }, [events]);
}

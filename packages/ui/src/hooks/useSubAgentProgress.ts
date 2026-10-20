'use client';

import { useMemo } from 'react';
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { colorForAgent } from '@/lib/agent-color';
import { deriveSubagentStatus, type SubagentRunStatus } from '@/lib/subagent-status';

export interface SubAgentRowInfo {
  id: string;
  name: string;
  color: string;
  /**
   * Plan 571: the single shared vocabulary (see `src/lib/subagent-status.ts`).
   * Previously this was a fourth spelling of the same lifecycle that could not
   * express "killed", so a user-cancelled sub-agent rendered as a failure.
   */
  status: SubagentRunStatus;
  eventCount?: number;
  sessionId?: string;
  /**
   * Path to the jsonl transcript on disk. Populated from the progress events
   * rather than hardcoded `undefined` — the backend has always emitted it and
   * the row now surfaces it as a "read full transcript" affordance.
   */
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

/**
 * Derive one sub-agent's status from its ordered progress events.
 *
 * Kept as a named export because it encodes a subtle rule worth testing
 * directly: a background spawn receipt is a *successful* tool result that says
 * nothing about the child, so the child stays `running` until its own terminal
 * event arrives.
 */
export function getSubAgentStatus(events: AgentProgressEventWithMeta[]): SubagentRunStatus {
  return deriveSubagentStatus(events);
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
 * Read the transcript path off whichever event carries it.
 *
 * `BackgroundAgentLifecycle` allocates the file before the first progress
 * event, so in practice the `started` event already has it. Scanning in
 * reverse means the most recent value wins if a run ever reallocates.
 */
function getOutputFilePathFromEvents(events: AgentProgressEventWithMeta[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const value = (events[i] as { outputFilePath?: unknown }).outputFilePath;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
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
        outputFilePath: getOutputFilePathFromEvents(agentEvents),
      });
    }

    return agents;
  }, [events]);
}

'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CaretRightIcon,
  CircleNotchIcon,
  RobotIcon,
} from '@/components/icons';
import { useStreamingAgentProgress, type AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import { useStreamPhase } from '@/hooks/useStreamPhase';

export interface SubAgentInfo {
  id: string;
  name: string;
  color: string;
  status: 'waiting' | 'running' | 'completed' | 'error';
  description?: string;
  eventCount?: number;
  /** DB session ID for this sub-agent, available after session is created */
  sessionId?: string;
}

interface SubAgentPanelProps {
  sessionId: string;
  onOpenSubAgent?: (agentName: string, agentSessionId?: string) => void;
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

function getAgentStatus(events: AgentProgressEventWithMeta[]): SubAgentInfo['status'] {
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

export function useSubAgents(sessionId: string): SubAgentInfo[] {
  const events = useStreamingAgentProgress(sessionId);

  return useMemo(() => {
    const groups = groupEventsByAgent(events);
    const agents: SubAgentInfo[] = [];
    let index = 0;

    for (const [agentId, agentEvents] of groups) {
      const customName = getAgentDisplayNameFromEvents(agentEvents);
      const status = getAgentStatus(agentEvents);
      const isTerminal = status === 'completed' || status === 'error';
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
      });
      index++;
    }

    return agents;
  }, [events]);
}

export function SubAgentPanel({ sessionId, onOpenSubAgent }: SubAgentPanelProps) {
  const agents = useSubAgents(sessionId);
  const phase = useStreamPhase(sessionId);
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  const isActive = phase === 'starting' || phase === 'streaming' || phase === 'awaiting_permission' || phase === 'persisting';
  const hasRunningAgents = agents.some(a => a.status === 'running');
  const allCompleted = agents.length > 0 && agents.every(a => a.status === 'completed' || a.status === 'error');

  // Auto-expand when new agents start running
  useEffect(() => {
    if (hasRunningAgents && isActive) {
      setExpanded(true);
      setDismissed(false);
    }
  }, [hasRunningAgents, isActive]);

  // Auto-dismiss when all agents completed and stream is done
  useEffect(() => {
    if (allCompleted && !isActive && !dismissed) {
      // Keep panel visible for a few seconds then allow dismissal
      const timer = setTimeout(() => {
        // Panel stays visible but can be collapsed
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [allCompleted, isActive, dismissed]);

  // Don't render if no agents or manually dismissed
  if (agents.length === 0) return null;
  if (dismissed) return null;

  return (
    <div className="sub-agent-panel-wrapper">
      <div className="sub-agent-panel">
        {/* Header bar with robot icon */}
        <div className="sub-agent-header">
          <button
            type="button"
            className="sub-agent-header-toggle"
            onClick={() => setExpanded((prev) => !prev)}
          >
            <RobotIcon size={14} className="sub-agent-robot-icon" />
            <CaretRightIcon
              size={12}
              className={`sub-agent-caret ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="sub-agent-header-title">
              {agents.length} 个后台智能体
              {agents.length > 1 && ' （使用 @ 标记智能体）'}
            </span>
          </button>
        </div>

        {/* Agent list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              className="overflow-hidden"
            >
              <div className="sub-agent-list">
                {agents.map((agent) => (
                  <SubAgentRow
                    key={agent.id}
                    agent={agent}
                    onOpen={() => onOpenSubAgent?.(agent.name, agent.sessionId)}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface SubAgentRowProps {
  agent: SubAgentInfo;
  onOpen: () => void;
}

function SubAgentRow({ agent, onOpen }: SubAgentRowProps) {
  return (
    <div className="sub-agent-row">
      <div className="sub-agent-row-content">
        <span
          className="sub-agent-name"
          style={{ color: agent.color }}
        >
          {agent.name}
        </span>
        <span className="sub-agent-status">
          {agent.description}
        </span>
      </div>

      <div className="sub-agent-row-actions">
        {agent.status === 'running' && (
          <CircleNotchIcon size={14} weight="bold" className="animate-spin text-muted-foreground" />
        )}
        <button
          type="button"
          className="sub-agent-open-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          打开
        </button>
      </div>
    </div>
  );
}

export default SubAgentPanel;

'use client';

import React, { useState, useEffect } from 'react';
import { useConversationStore, type Thread } from '@/stores/conversation-store';
import { CircleNotchIcon, CheckIcon, XIcon, RobotIcon } from '@/components/icons';
import { subscribeToPhase } from '@/lib/stream-session-manager';
import type { StreamPhase } from '@/types/message';
import { useSubAgents } from '@/components/chat/SubAgentPanel';

interface SubAgentThreadItemProps {
  thread: Thread;
  isActive: boolean;
}

const ACTIVE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];

export function SubAgentThreadItem({ thread, isActive }: SubAgentThreadItemProps) {
  const { setActiveThread } = useConversationStore();
  const [isRunning, setIsRunning] = useState(false);
  const subAgents = useSubAgents(thread.id);

  // Subscribe to stream phase changes
  useEffect(() => {
    const unsubscribe = subscribeToPhase(thread.id, (phase) => {
      setIsRunning(ACTIVE_PHASES.includes(phase));
    });
    return unsubscribe;
  }, [thread.id]);

  const handleClick = () => {
    setActiveThread(thread.id);
  };

  // Get the most active sub-agent to display
  const displayAgent = subAgents[0];
  const runningAgents = subAgents.filter((a) => a.status === 'running');
  const completedAgents = subAgents.filter((a) => a.status === 'completed');

  return (
    <div
      className={`sub-agent-thread-item${isActive ? ' active' : ''}`}
      onClick={handleClick}
      title={thread.title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      <div className="sub-agent-thread-content">
        <span className="sub-agent-thread-title">
          {thread.title || 'New Thread'}
        </span>

        {displayAgent && (
          <span
            className="sub-agent-thread-badge"
            style={{ color: displayAgent.color }}
          >
            {displayAgent.name}
          </span>
        )}
      </div>

      <div className="sub-agent-thread-meta">
        {isRunning ? (
          <span className="sub-agent-thread-indicator" title="Agent is running...">
            <CircleNotchIcon size={14} weight="bold" className="animate-spin" />
          </span>
        ) : runningAgents.length > 0 ? (
          <span className="sub-agent-thread-indicator" title="Sub-agent running...">
            <CircleNotchIcon size={14} weight="bold" className="animate-spin" />
          </span>
        ) : completedAgents.length > 0 && subAgents.every(a => a.status === 'completed' || a.status === 'error') ? (
          <span className="sub-agent-thread-indicator completed" title="Completed">
            <CheckIcon size={14} weight="bold" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default SubAgentThreadItem;

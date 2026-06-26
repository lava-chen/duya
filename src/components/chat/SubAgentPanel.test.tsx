/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';
import type { StreamPhase } from '@/types';

const mocks = vi.hoisted(() => ({
  events: [] as AgentProgressEventWithMeta[],
  phase: 'idle' as StreamPhase,
}));

vi.mock('@/hooks/useStreamingAgentProgress', () => ({
  useStreamingAgentProgress: () => mocks.events,
}));

vi.mock('@/hooks/useStreamPhase', () => ({
  useStreamPhase: () => mocks.phase,
}));

vi.mock('@/components/icons', () => ({
  CaretRightIcon: ({ className }: { className?: string }) => <span data-testid="caret" className={className} />,
  CircleNotchIcon: () => <span data-testid="spinner" />,
  RobotIcon: () => <span data-testid="robot" />,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => <div {...props}>{children}</div>,
  },
}));

import { SubAgentPanel } from './SubAgentPanel';

function agentEvent(type: AgentProgressEventWithMeta['type']): AgentProgressEventWithMeta {
  return {
    type,
    agentId: 'agent-1',
    agentName: 'Researcher',
    sessionId: 'sub-session-1',
    receivedAt: 1,
    seq: 1,
  };
}

describe('SubAgentPanel lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.events = [agentEvent('started')];
    mocks.phase = 'streaming';
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('collapses immediately and disappears five seconds after all agents finish', () => {
    const { container, rerender } = render(<SubAgentPanel sessionId="session-1" />);
    expect(container.querySelector('.sub-agent-list')).toBeInTheDocument();

    mocks.events = [agentEvent('done')];
    mocks.phase = 'completed';
    rerender(<SubAgentPanel sessionId="session-1" />);

    expect(container.querySelector('.sub-agent-panel-wrapper')).toBeInTheDocument();
    expect(container.querySelector('.sub-agent-list')).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4999));
    expect(container.querySelector('.sub-agent-panel-wrapper')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.sub-agent-panel-wrapper')).not.toBeInTheDocument();
  });

  it('cancels dismissal and expands again when a new agent starts', () => {
    const { container, rerender } = render(<SubAgentPanel sessionId="session-1" />);

    mocks.events = [agentEvent('done')];
    mocks.phase = 'completed';
    rerender(<SubAgentPanel sessionId="session-1" />);
    act(() => vi.advanceTimersByTime(2000));

    mocks.events = [agentEvent('started')];
    mocks.phase = 'streaming';
    rerender(<SubAgentPanel sessionId="session-1" />);

    expect(container.querySelector('.sub-agent-list')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(5000));
    expect(container.querySelector('.sub-agent-panel-wrapper')).toBeInTheDocument();
  });
});

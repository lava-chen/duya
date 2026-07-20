/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';

const mocks = vi.hoisted(() => ({
  events: [] as AgentProgressEventWithMeta[],
}));

vi.mock('@/hooks/useStreamingAgentProgress', () => ({
  useStreamingAgentProgress: () => mocks.events,
}));

vi.mock('@/stores/conversation-store', () => {
  const hook = (selector: (state: { activeThreadId: string }) => unknown) =>
    selector({ activeThreadId: 'parent-session' });
  return {
    useConversationStore: Object.assign(hook, {
      getState: () => ({ setActiveThread: vi.fn() }),
    }),
  };
});

vi.mock('../registry', () => ({
  getRenderer: () => ({ getSummary: () => 'Inspect lifecycle' }),
}));

vi.mock('../chrome/ActionRowChrome', () => ({
  ActionRowChrome: ({ status, children }: { status: string; children: React.ReactNode }) => (
    <div data-testid="action-row" data-status={status}>{children}</div>
  ),
}));

vi.mock('@/components/icons', () => ({
  RobotIcon: () => <span data-testid="robot" />,
}));

import { SubAgentToolRow } from './SubAgentToolRow';

const backgroundResult = JSON.stringify({
  agentType: 'Explore',
  resolvedAgentType: 'Explore',
  description: 'Inspect lifecycle',
  sessionId: 'sub-session',
  taskId: 'task-1',
  agentId: 'task-1',
  background: true,
  status: 'running',
});

function progress(
  type: AgentProgressEventWithMeta['type'],
  overrides: Partial<AgentProgressEventWithMeta> = {},
): AgentProgressEventWithMeta {
  return {
    type,
    agentId: 'task-1',
    sessionId: 'sub-session',
    agentType: 'Explore',
    receivedAt: type === 'done' ? 2 : 1,
    seq: type === 'done' ? 2 : 1,
    ...overrides,
  };
}

describe('SubAgentToolRow background status', () => {
  beforeEach(() => {
    mocks.events = [progress('started')];
  });

  it('shows running after the Agent tool returns its launch receipt', () => {
    render(
      <SubAgentToolRow
        tool={{
          id: 'tool-1',
          name: 'Agent',
          input: { prompt: 'Inspect lifecycle' },
          result: backgroundResult,
        }}
      />,
    );

    expect(screen.getByTestId('action-row')).toHaveAttribute('data-status', 'running');
  });

  it('shows success only after the sub-agent emits done', () => {
    mocks.events = [progress('started'), progress('done')];
    render(
      <SubAgentToolRow
        tool={{
          id: 'tool-1',
          name: 'Agent',
          input: { prompt: 'Inspect lifecycle' },
          result: backgroundResult,
        }}
      />,
    );

    expect(screen.getByTestId('action-row')).toHaveAttribute('data-status', 'success');
  });

  it('shows the concrete command instead of a generic running label', () => {
    mocks.events = [progress('tool_use', {
      toolName: 'bash',
      toolInput: { command: 'npm run typecheck:all' },
    })];

    render(
      <SubAgentToolRow
        tool={{
          id: 'tool-1',
          name: 'Agent',
          input: { prompt: 'Inspect lifecycle' },
          result: backgroundResult,
        }}
      />,
    );

    expect(screen.getByText(/正在执行命令：npm run typecheck:all/)).toBeInTheDocument();
  });

  it('keeps the last concrete file activity visible while the agent thinks', () => {
    mocks.events = [
      progress('tool_result', {
        toolName: 'read_file',
        toolInput: { file_path: 'packages/agent/src/agent/DuyaAgent.ts' },
      }),
      progress('thinking', { receivedAt: 2, seq: 2 }),
    ];

    render(
      <SubAgentToolRow
        tool={{
          id: 'tool-1',
          name: 'Agent',
          input: { prompt: 'Inspect lifecycle' },
          result: backgroundResult,
        }}
      />,
    );

    expect(screen.getByText(/刚完成读取文件：packages\/agent\/src\/agent\/DuyaAgent.ts/)).toBeInTheDocument();
    expect(screen.queryByText('思考中...')).not.toBeInTheDocument();
  });
});

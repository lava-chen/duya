/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
  ActionRowChrome: ({
    status,
    children,
    onClick,
  }: {
    status: string;
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <div data-testid="action-row" data-status={status} onClick={onClick}>{children}</div>
  ),
}));

vi.mock('@/components/icons', () => ({
  RobotIcon: () => <span data-testid="robot" />,
}));

import { SubAgentToolRow, selectSubagentEvents } from './SubAgentToolRow';

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

describe('SubAgentToolRow open-panel payload', () => {
  beforeEach(() => {
    mocks.events = [progress('started')];
  });

  it('carries the parent thread and the run task id so the panel can stop it', () => {
    const dispatched: Event[] = [];
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
      dispatched.push(event);
      return true;
    });
    try {
      render(
        <SubAgentToolRow
          tool={{
            id: 'tool-1',
            name: 'Agent',
            input: { prompt: 'Inspect lifecycle' },
            result: backgroundResult,
          }}
          agentProgressEvents={mocks.events}
        />,
      );
      fireEvent.click(screen.getByTestId('action-row'));

      const event = dispatched[0] as CustomEvent<Record<string, string>>;
      expect(event.type).toBe('duya:open-session-panel');
      expect(event.detail).toMatchObject({
        sessionId: 'sub-session',
        parentSessionId: 'parent-session',
        taskId: 'task-1',
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('selectSubagentEvents (plan 571 correlation fix)', () => {
  const event = (
    agentId: string,
    type: AgentProgressEventWithMeta['type'],
    extra: Partial<AgentProgressEventWithMeta> = {},
  ): AgentProgressEventWithMeta => progress(type, { agentId, ...extra });

  it('matches a running run by the task id the started event carries', () => {
    const events = [
      event('task-1', 'started', { agentDescription: 'Inspect lifecycle' }),
      event('task-1', 'text', { data: 'child one' }),
      event('task-2', 'started', { agentDescription: 'Inspect lifecycle' }),
      event('task-2', 'text', { data: 'child two' }),
    ];
    // No receipt yet: the only shared handle is the description, which matches
    // BOTH concurrent same-type runs — the ambiguity plan 571 had to remove.
    const byDesc = selectSubagentEvents(events, { description: 'Inspect lifecycle' });
    expect(byDesc).toHaveLength(2);

    // Once the launch receipt names the task, the id wins outright.
    const byId = selectSubagentEvents(events, { taskId: 'task-2', description: 'Inspect lifecycle' });
    expect(byId).toHaveLength(2);
    expect(byId.every((e) => e.agentId === 'task-2')).toBe(true);
    expect(byId.map((e) => e.data)).toEqual([undefined, 'child two']);
  });

  it('prefers the child session id over everything else', () => {
    const events = [
      event('task-1', 'tool_use', { toolName: 'read', sessionId: 'sub-1' }),
      event('task-1', 'tool_use', { toolName: 'read', sessionId: 'sub-2' }),
    ];
    const selected = selectSubagentEvents(events, { sessionId: 'sub-2', taskId: 'task-1' });
    expect(selected).toHaveLength(1);
    expect(selected[0].sessionId).toBe('sub-2');
  });

  it('returns nothing rather than every event when several runs are present', () => {
    const events = [
      event('task-1', 'started', { agentType: 'Explore' }),
      event('task-2', 'started', { agentType: 'Explore' }),
    ];
    // A row that cannot identify its run must render no events. Returning
    // everything here is exactly the two-concurrent-sub-agents bug.
    expect(selectSubagentEvents(events, {})).toEqual([]);
  });

  it('falls back to all events when a single run is in flight', () => {
    const events = [event('task-1', 'started'), event('task-1', 'text', { data: 'x' })];
    expect(selectSubagentEvents(events, {})).toHaveLength(2);
  });

  it('keeps the agent-type fallback for pre-571 sessions without a started event', () => {
    const events = [
      event('legacy', 'text', { agentType: 'Plan', data: 'a' }),
      event('legacy', 'text', { agentType: 'Explore', data: 'b' }),
    ];
    const selected = selectSubagentEvents(events, { subagentType: 'plan' });
    expect(selected).toHaveLength(1);
    expect(selected[0].data).toBe('a');
  });
});

/**
 * SessionMessagesPanel.test.tsx
 *
 * The header is where plan 571's promise is visible: a running sub-agent has
 * to read as RUNNING, a user-cancelled one as STOPPED, and a crashed one as
 * FAILED — three different words, because collapsing "stopped" into "failed"
 * is the confusion this phase exists to remove. The stop control also has to
 * appear only while a run is live, and only when the tab actually carries the
 * parent/task ids the kill endpoint needs.
 *
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentProgressEvent } from '@/lib/stream-session-manager';
import type { PageTab } from '../panels/registry';

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: AgentProgressEvent) => void>(),
  fetch: vi.fn(async () => new Response('{}', { status: 200 })),
  setActiveThread: vi.fn<(id: string) => void>(),
}));

vi.mock('@/lib/stream-session-manager', () => ({
  streamSessionManager: {
    subscribeToSubagentProgress: (_id: string, listener: (event: AgentProgressEvent) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    getSubagentProgressSnapshot: () => ({ events: [], startedAt: null, terminalAt: null }),
  },
}));

vi.mock('@/lib/ipc-client', () => ({
  getThreadIPC: vi.fn(async () => ({ thread: { title: 'Explored lifecycle' } })),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ messages: {}, loadThreadMessages: vi.fn(async () => undefined) }),
    { getState: () => ({ setActiveThread: mocks.setActiveThread }) },
  ),
}));

vi.mock('@/components/chat/ReadOnlySessionChat', () => ({
  ReadOnlySessionChat: ({ sessionId, live }: { sessionId: string; live?: { isStreaming: boolean } }) => (
    <div
      data-testid="read-only-chat"
      data-session={sessionId}
      data-streaming={String(live?.isStreaming ?? false)}
      data-has-live={String(live !== undefined)}
    />
  ),
}));

vi.mock('@/components/icons', () => ({
  ArrowSquareOutIcon: () => <span data-icon="external" />,
  ChatCircleIcon: () => <span data-icon="chat" />,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { SessionMessagesPanel } from '../panels/SessionMessagesPanel';

function tab(params: Record<string, unknown>): PageTab {
  return { id: 'tab-1', pageId: 'session-messages', params } as PageTab;
}

function emit(event: AgentProgressEvent): void {
  // The subscription drives React state, so the event has to land inside act().
  act(() => {
    mocks.listeners.forEach((listener) => listener(event));
  });
}

function renderPanel(params: Record<string, unknown> = {}) {
  return render(
    <SessionMessagesPanel
      tab={tab({ sessionId: 'child-1', title: 'Explore', parentSessionId: 'parent-1', taskId: 'task-1', ...params })}
      embedded={false}
    />,
  );
}

describe('SessionMessagesPanel runtime header', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.fetch.mockClear();
    (window as unknown as { electronAPI?: unknown }).electronAPI = {
      getAgentServerPort: vi.fn(async () => 4321),
    };
    globalThis.fetch = mocks.fetch as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('hides the runtime chrome for a session with no sub-agent run (workflow node)', () => {
    renderPanel();
    // No events at all: claiming `pending` forever would be a lie, and the
    // DB poll must stay in charge for these panels.
    expect(screen.queryByTestId('subagent-status-pill')).toBeNull();
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
    expect(screen.getByTestId('read-only-chat')).toHaveAttribute('data-has-live', 'false');
  });

  it('shows a running pill, a live body and the stop control while the run streams', () => {
    renderPanel();
    emit({ type: 'started', receivedAt: Date.now() - 3_000, sessionId: 'child-1' });
    emit({ type: 'text', data: 'working', receivedAt: Date.now(), sessionId: 'child-1' });

    const pill = screen.getByTestId('subagent-status-pill');
    expect(pill).toHaveAttribute('data-status', 'running');
    expect(pill).toHaveTextContent('panel.session.status.running');
    // Streaming is passed through instead of the old hardcoded false.
    expect(screen.getByTestId('read-only-chat')).toHaveAttribute('data-streaming', 'true');
    expect(screen.getByTestId('read-only-chat')).toHaveAttribute('data-has-live', 'true');
    expect(screen.getByTestId('subagent-elapsed')).not.toHaveTextContent('—');
    expect(screen.getByTestId('subagent-stop')).toBeInTheDocument();
  });

  it('reads a killed run as stopped, never as failed', () => {
    renderPanel();
    emit({ type: 'started', receivedAt: Date.now() - 5_000, sessionId: 'child-1' });
    emit({ type: 'done', data: 'killed: user_kill', receivedAt: Date.now(), sessionId: 'child-1' });

    const pill = screen.getByTestId('subagent-status-pill');
    expect(pill).toHaveAttribute('data-status', 'killed');
    expect(pill).toHaveTextContent('panel.session.status.killed');
    // The distinction is the point: no failure wording, no error styling.
    expect(pill).not.toHaveTextContent('panel.session.status.failed');
    expect(pill.className).toContain('border-[var(--border-strong)]');
    // Terminal → the body stops streaming and the stop control disappears.
    expect(screen.getByTestId('read-only-chat')).toHaveAttribute('data-streaming', 'false');
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
  });

  it('reads a crashed run as failed and freezes the elapsed timer', () => {
    renderPanel();
    emit({ type: 'started', receivedAt: 1_000, sessionId: 'child-1' });
    emit({ type: 'error', data: 'provider exploded', receivedAt: 6_000, sessionId: 'child-1' });

    const pill = screen.getByTestId('subagent-status-pill');
    expect(pill).toHaveAttribute('data-status', 'failed');
    expect(pill.className).toContain('border-[var(--error)]');
    // 5000ms → formatElapsed's "5.0s" bucket.
    expect(screen.getByTestId('subagent-elapsed')).toHaveTextContent('5.0s');
  });

  it('counts tool invocations in the header', () => {
    renderPanel();
    emit({ type: 'started', receivedAt: Date.now(), sessionId: 'child-1' });
    emit({ type: 'tool_use', toolName: 'read', receivedAt: Date.now(), sessionId: 'child-1' });
    emit({ type: 'tool_result', toolName: 'read', toolResult: 'ok', receivedAt: Date.now(), sessionId: 'child-1' });
    emit({ type: 'tool_use', toolName: 'bash', receivedAt: Date.now(), sessionId: 'child-1' });

    expect(screen.getByTestId('subagent-tool-counts')).toHaveTextContent('"count":2');
  });

  it('hides the stop control when the tab has no parent thread or task id', () => {
    renderPanel({ parentSessionId: undefined });
    emit({ type: 'started', receivedAt: Date.now(), sessionId: 'child-1' });
    // Without a parent session id the kill endpoint cannot be addressed, so
    // offering the button would only produce a guaranteed failure.
    expect(screen.queryByTestId('subagent-stop')).toBeNull();
  });

  it('POSTs the kill request at the parent thread and swallows a failure', async () => {
    renderPanel();
    emit({ type: 'started', receivedAt: Date.now(), sessionId: 'child-1' });

    fireEvent.click(screen.getByTestId('subagent-stop'));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/sessions/parent-1/subagents/kill',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ taskId: 'task-1' }) }),
    );

    mocks.fetch.mockResolvedValueOnce(new Response('nope', { status: 404 }) as never);
    fireEvent.click(screen.getByTestId('subagent-stop'));
    // A sub-agent that finished between click and request is not a user-facing
    // error: the panel stays mounted and only notes it inline.
    await screen.findByTestId('subagent-stop-notice');
    expect(screen.getByTestId('subagent-status-pill')).toBeInTheDocument();
  });

  it('keeps the open-in-main-view control', () => {
    renderPanel();
    fireEvent.click(screen.getByTitle('panel.session.viewInMain'));
    expect(mocks.setActiveThread).toHaveBeenCalledWith('child-1');
  });
});

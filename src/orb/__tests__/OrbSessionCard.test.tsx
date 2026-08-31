/**
 * OrbSessionCard smoke tests — header buttons + typing indicator + empty
 * stream. State-streaming / auto-inject behaviour is exercised through
 * OrbApp.test.tsx (the integration path).
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OrbSessionCard } from '../components/OrbSessionCard';
import type { OrbState, Turn } from '../types';

const noop = async () => undefined;

const baseProps = {
  messages: [] as Turn[],
  state: 'INPUT' as OrbState,
  progress: { label: null, stage: 'thinking' as const },
  pendingText: '',
  setPendingText: vi.fn(),
  pendingAttachments: [],
  setPendingAttachments: vi.fn(),
  autoInjectBanner: null,
  setAutoInjectBanner: vi.fn(),
  onSubmit: vi.fn(noop),
  onNewChat: vi.fn(noop),
  onCopyLast: vi.fn(noop),
  onClose: vi.fn(noop),
  onInsertTab: vi.fn(noop),
};

beforeEach(() => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    orb: {
      chatConfig: vi.fn().mockResolvedValue({ model: 'test-model', options: [] }),
      setModel: vi.fn().mockResolvedValue({ ok: true }),
      plugin: { registry: { list: vi.fn().mockResolvedValue({ data: [] }) } },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrbSessionCard', () => {
  it('renders three header buttons (new chat, copy, close)', () => {
    render(<OrbSessionCard {...baseProps} messages={[]} />);
    expect(screen.getByLabelText('新建会话')).toBeInTheDocument();
    expect(screen.getByLabelText('复制最后一条助手回复')).toBeInTheDocument();
    expect(screen.getByLabelText('关闭')).toBeInTheDocument();
  });

  it('invokes onNewChat when the + button is clicked', () => {
    render(<OrbSessionCard {...baseProps} messages={[]} />);
    fireEvent.click(screen.getByLabelText('新建会话'));
    expect(baseProps.onNewChat).toHaveBeenCalled();
  });

  it('invokes onClose when the × button is clicked', () => {
    render(<OrbSessionCard {...baseProps} messages={[]} />);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(baseProps.onClose).toHaveBeenCalled();
  });

  it('disables copy when no assistant message exists', () => {
    render(<OrbSessionCard {...baseProps} messages={[]} />);
    const copy = screen.getByLabelText('复制最后一条助手回复');
    expect(copy).toBeDisabled();
  });

  it('enables copy when at least one assistant message has text', () => {
    const messages: Turn[] = [
      {
        id: 't1',
        role: 'assistant',
        text: '你好',
        createdAt: 1,
        finishedAt: 1,
      },
    ];
    render(<OrbSessionCard {...baseProps} messages={messages} />);
    const copy = screen.getByLabelText('复制最后一条助手回复');
    expect(copy).not.toBeDisabled();
  });

  it('renders the empty stream with the input placeholder', () => {
    render(<OrbSessionCard {...baseProps} messages={[]} />);
    expect(
      screen.getByPlaceholderText('问 Duya 任何事...'),
    ).toBeInTheDocument();
  });

  it('shows the typing dots while LOADING with no assistant text yet', () => {
    const messages: Turn[] = [
      {
        id: 't1',
        role: 'user',
        text: 'hello',
        createdAt: 1,
      },
      {
        id: 't2',
        role: 'assistant',
        text: '',
        createdAt: 2,
      },
    ];
    render(
      <OrbSessionCard
        {...baseProps}
        messages={messages}
        state="LOADING"
        progress={{ label: '思考中', stage: 'thinking' }}
      />,
    );
    // typing dots component uses aria-label "思考中" (progress.label).
    expect(screen.getByLabelText('思考中')).toBeInTheDocument();
  });

  it('renders the redacted banner when autoInjectBanner is set', () => {
    render(
      <OrbSessionCard
        {...baseProps}
        autoInjectBanner="当前焦点被遮蔽，未注入上下文"
      />,
    );
    expect(
      screen.getByText('当前焦点被遮蔽，未注入上下文'),
    ).toBeInTheDocument();
  });

  it('renders user and assistant bubbles with role classes', () => {
    const messages: Turn[] = [
      {
        id: 't1',
        role: 'user',
        text: 'hi',
        createdAt: 1,
      },
      {
        id: 't2',
        role: 'assistant',
        text: 'world',
        createdAt: 2,
        finishedAt: 3,
      },
    ];
    render(<OrbSessionCard {...baseProps} messages={messages} />);
    expect(document.querySelector('.orb-message--user')).toBeTruthy();
    expect(document.querySelector('.orb-message--assistant')).toBeTruthy();
  });
});
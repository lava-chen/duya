/**
 * session.test.ts — unit tests for the session-domain slash-command executors
 * (new / clear / export / copy / rename / resume / stop / queue / compact).
 *
 * Strategy: replace the three modules that own live state (conversation store,
 * stream-session-manager, rollout IPC) and the two bot-mode helpers, then drive
 * each executor through a fake `CommandAppBridge` and assert on the *observable*
 * effect — which bridge calls fired, which store mutation was requested, what
 * the command reported back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAppBridge } from './bridge';
import type { CommandContext, CommandResult } from '../types';
import type { Message } from '@/types/message';

// ---------------------------------------------------------------------------
// Mocks — hoisted before the module under test is imported.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  clearQueuedMessages: vi.fn(),
  getPendingMessages: vi.fn(() => [] as { content: string; displayContent?: string }[]),
  hasQueuedMessages: vi.fn(() => false),
  exportRolloutIPC: vi.fn(),
  resolveChatMode: vi.fn(() => 'workspace' as 'workspace' | 'bot-direct' | 'room'),
  cancelPendingTurnsForSession: vi.fn(),
  writeText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: { getState: mocks.getState },
}));

vi.mock('@/lib/stream-session-manager', () => ({
  clearQueuedMessages: mocks.clearQueuedMessages,
  getPendingMessages: mocks.getPendingMessages,
  hasQueuedMessages: mocks.hasQueuedMessages,
}));

vi.mock('@/lib/ipc-client', () => ({ exportRolloutIPC: mocks.exportRolloutIPC }));

vi.mock('@/components/chat/bot/chat-mode', () => ({
  resolveChatMode: mocks.resolveChatMode,
}));

vi.mock('@/components/chat/bot/send/scheduled-turns', () => ({
  cancelPendingTurnsForSession: mocks.cancelPendingTurnsForSession,
}));

vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });

const { SESSION_EXECUTORS } = await import('./session');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { id: `${role}-${text.slice(0, 6)}`, role, content: text, timestamp: 0, ...extra };
}

function assistantBlocks(text: string): Message {
  return {
    id: 'assistant-blocks',
    role: 'assistant',
    timestamp: 0,
    content: [
      { type: 'text', text: 'visible answer' },
      { type: 'text', text: 'muttered', phase: 'commentary' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ],
    displayContent: text,
  } as unknown as Message;
}

interface BridgeSpies {
  bridge: CommandAppBridge;
  resetSession: ReturnType<typeof vi.fn>;
  clearMessages: ReturnType<typeof vi.fn>;
  stopTurn: ReturnType<typeof vi.fn>;
  compactContext: ReturnType<typeof vi.fn>;
  openPanel: ReturnType<typeof vi.fn>;
  promptInput: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  snapshot: { sessionId?: string; workingDirectory?: string | null };
}

function makeBridge(overrides: Partial<BridgeSpies['snapshot']> = {}): BridgeSpies {
  const snapshot: BridgeSpies['snapshot'] = {
    sessionId: 's-1',
    workingDirectory: 'E:/Projects/duya',
    ...overrides,
  };
  const spies = {
    resetSession: vi.fn().mockResolvedValue({ oldSessionId: 's-1', newSessionId: 's-2' }),
    clearMessages: vi.fn(),
    stopTurn: vi.fn(),
    compactContext: vi.fn(),
    openPanel: vi.fn(),
    promptInput: vi.fn().mockResolvedValue(null),
    toast: vi.fn(),
  };
  return {
    bridge: {
      sendPrompt: vi.fn(),
      getSessionSnapshot: () => snapshot,
      clearMessages: spies.clearMessages,
      resetSession: spies.resetSession,
      stopTurn: spies.stopTurn,
      compactContext: spies.compactContext,
      focusSession: vi.fn(),
      requestRecap: vi.fn(),
      setSessionModel: vi.fn(),
      setEffort: vi.fn(),
      setPermissionMode: vi.fn(),
      toggleMode: vi.fn(),
      openModelPicker: vi.fn(),
      openPanel: spies.openPanel,
      promptInput: spies.promptInput,
      toast: spies.toast,
    },
    snapshot,
    ...spies,
  };
}

function run(name: string, input: string, bridge: CommandAppBridge): Promise<CommandResult> {
  const [command, ...args] = input.replace(/^\//, '').split(/\s+/).filter(Boolean);
  const executor = SESSION_EXECUTORS[command];
  if (!executor) throw new Error(`no executor for /${command}`);
  return Promise.resolve(executor({ args, raw: `/${command}`, app: bridge } as CommandContext));
}

const THREAD = { id: 's-1', title: '旧标题' };

function storeWith(messages: Message[], threads: unknown[] = [THREAD]) {
  mocks.getState.mockReturnValue({
    activeThreadId: 's-1',
    messages: { 's-1': messages },
    threads,
    updateThreadTitle: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getState.mockReset();
  mocks.exportRolloutIPC.mockReset();
  mocks.resolveChatMode.mockReturnValue('workspace');
});

// ---------------------------------------------------------------------------
// new / clear / stop / compact
// ---------------------------------------------------------------------------

describe('session executors — new / clear / stop / compact', () => {
  it('/new resets the session and reports the new id', async () => {
    const { bridge, resetSession } = makeBridge();
    expect(await run('new', '/new', bridge)).toEqual({ type: 'session_reset', newSessionId: 's-2' });
    expect(resetSession).toHaveBeenCalledTimes(1);
  });

  it('/new reports an empty newSessionId as undefined, not an empty string', async () => {
    const { bridge, resetSession } = makeBridge();
    resetSession.mockResolvedValue({ oldSessionId: 's-1', newSessionId: '' });
    expect(await run('new', '/new', bridge)).toEqual({ type: 'session_reset', newSessionId: undefined });
  });

  it('/clear clears the transcript, toasts, and produces no dialog', async () => {
    const { bridge, clearMessages, toast } = makeBridge();
    const result = await run('clear', '/clear', bridge);
    expect(result).toEqual({ type: 'dismiss' });
    expect(clearMessages).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已清空当前对话（DB 历史保留）', 'success');
  });

  it('/stop interrupts the live turn', async () => {
    const { bridge, stopTurn, toast } = makeBridge();
    expect(await run('stop', '/stop', bridge)).toEqual({ type: 'dismiss' });
    expect(stopTurn).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已请求停止当前回合', 'info');
  });

  it('/compact triggers background compaction', async () => {
    const { bridge, compactContext, toast } = makeBridge();
    expect(await run('compact', '/compact', bridge)).toEqual({ type: 'dismiss' });
    expect(compactContext).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('已开始压缩上下文（后台运行）', 'info');
  });

  it('/compact refuses when no session is open instead of silently no-oping', async () => {
    const { bridge, compactContext } = makeBridge({ sessionId: undefined });
    const result = await run('compact', '/compact', bridge);
    expect(result.type).toBe('error');
    expect(compactContext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------

describe('session executors — copy', () => {
  it('/copy copies the last assistant reply and skips user/tool rows', async () => {
    storeWith([
      message('user', 'question'),
      message('assistant', 'first answer'),
      message('user', 'follow-up'),
    ]);
    const { bridge, toast } = makeBridge();
    expect(await run('copy', '/copy', bridge)).toEqual({ type: 'dismiss' });
    expect(mocks.writeText).toHaveBeenCalledWith('first answer');
    expect(toast).toHaveBeenCalledWith('已复制最后一条回复', 'success');
  });

  it('/copy copies visible text only — commentary and tool blocks are excluded', async () => {
    storeWith([assistantBlocks('ignored')]);
    const { bridge } = makeBridge();
    await run('copy', '/copy', bridge);
    expect(mocks.writeText).toHaveBeenCalledWith('visible answer');
  });

  it('/copy errors when the transcript holds no assistant reply', async () => {
    storeWith([message('user', 'question')]);
    const { bridge } = makeBridge();
    const result = await run('copy', '/copy', bridge);
    expect(result.type).toBe('error');
    expect(mocks.writeText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rename / resume
// ---------------------------------------------------------------------------

describe('session executors — rename / resume', () => {
  it('/rename with an argument sets the title without prompting', async () => {
    storeWith([]);
    const updateThreadTitle = vi.fn();
    mocks.getState.mockReturnValue({
      activeThreadId: 's-1',
      messages: {},
      threads: [{ id: 's-1', title: '旧标题' }],
      updateThreadTitle,
    });
    const { bridge, promptInput } = makeBridge();
    const result = await run('rename', '/rename 新的 会话名', bridge);
    expect(result.type).toBe('text');
    expect(promptInput).not.toHaveBeenCalled();
    expect(updateThreadTitle).toHaveBeenCalledWith('s-1', '新的 会话名');
  });

  it('/rename without an argument prompts, seeded with the current title', async () => {
    const updateThreadTitle = vi.fn();
    mocks.getState.mockReturnValue({
      activeThreadId: 's-1',
      messages: {},
      threads: [{ id: 's-1', title: '旧标题' }],
      updateThreadTitle,
    });
    const { bridge, promptInput } = makeBridge();
    promptInput.mockResolvedValue('从弹窗输入的标题');
    const result = await run('rename', '/rename', bridge);
    expect(promptInput).toHaveBeenCalledWith(
      expect.objectContaining({ title: '重命名会话', initialValue: '旧标题' }),
    );
    expect(updateThreadTitle).toHaveBeenCalledWith('s-1', '从弹窗输入的标题');
    expect(result.type).toBe('text');
  });

  it('/rename treats a cancelled prompt as a no-op, not an empty title', async () => {
    const updateThreadTitle = vi.fn();
    mocks.getState.mockReturnValue({
      activeThreadId: 's-1',
      messages: {},
      threads: [{ id: 's-1', title: '旧标题' }],
      updateThreadTitle,
    });
    const { bridge, promptInput } = makeBridge();
    promptInput.mockResolvedValue(null);
    expect(await run('rename', '/rename', bridge)).toEqual({ type: 'dismiss' });
    expect(updateThreadTitle).not.toHaveBeenCalled();
  });

  it('/title is the alias entry for /rename', async () => {
    const updateThreadTitle = vi.fn();
    mocks.getState.mockReturnValue({
      activeThreadId: 's-1',
      messages: {},
      threads: [{ id: 's-1', title: '旧标题' }],
      updateThreadTitle,
    });
    const { bridge } = makeBridge();
    await run('title', '/title 别名标题', bridge);
    expect(updateThreadTitle).toHaveBeenCalledWith('s-1', '别名标题');
  });

  it('/resume opens the sessions panel when a session is active', async () => {
    const { bridge, openPanel } = makeBridge();
    expect(await run('resume', '/resume', bridge)).toEqual({ type: 'dismiss' });
    expect(openPanel).toHaveBeenCalledWith('sessions');
  });

  it('/resume explains itself instead of no-oping when there is no session', async () => {
    const { bridge, openPanel } = makeBridge({ sessionId: undefined });
    const result = await run('resume', '/resume', bridge);
    expect(result.type).toBe('text');
    expect(openPanel).not.toHaveBeenCalled();
  });

  it('/sessions is the alias entry for /resume', async () => {
    const { bridge, openPanel } = makeBridge();
    expect(await run('sessions', '/sessions', bridge)).toEqual({ type: 'dismiss' });
    expect(openPanel).toHaveBeenCalledWith('sessions');
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe('session executors — export', () => {
  it('/export puts a Markdown transcript on the clipboard', async () => {
    storeWith([
      message('user', '问题一'),
      message('assistant', '回答一'),
      message('assistant', 'ignored-summary', { isCompactSummary: true } as Partial<Message>),
    ]);
    const { bridge, toast } = makeBridge();
    const result = await run('export', '/export', bridge);
    expect(result.type).toBe('text');
    const written = mocks.writeText.mock.calls[0][0] as string;
    expect(written).toContain('# 旧标题');
    expect(written).toContain('- Session: s-1');
    expect(written).toContain('- Working directory: E:/Projects/duya');
    expect(written).toContain('## User');
    expect(written).toContain('问题一');
    expect(written).toContain('## Assistant');
    expect(toast).toHaveBeenCalledWith('Markdown 转录已复制到剪贴板', 'success');
  });

  it('/export errors on an empty transcript instead of writing a header-only file', async () => {
    storeWith([]);
    const { bridge } = makeBridge();
    const result = await run('export', '/export', bridge);
    expect(result.type).toBe('error');
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('/export rollout writes the real file through the main process and reports its path', async () => {
    storeWith([message('user', 'x')]);
    mocks.exportRolloutIPC.mockResolvedValue({ absolutePath: '/tmp/rollout-s-1.jsonl', lines: 7, bytes: 42 });
    const { bridge } = makeBridge();
    const result = await run('export', '/export rollout', bridge);
    expect(mocks.exportRolloutIPC).toHaveBeenCalledWith('s-1');
    expect(result).toEqual({ type: 'text', content: '已导出 7 行（42 字节）：\n/tmp/rollout-s-1.jsonl' });
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('/export rejects an unknown format and lists the real ones', async () => {
    storeWith([message('user', 'x')]);
    const { bridge } = makeBridge();
    const result = await run('export', '/export pdf', bridge);
    expect(result.type).toBe('error');
    expect((result as { message: string }).message).toContain('/export rollout');
    expect(mocks.exportRolloutIPC).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

describe('session executors — queue', () => {
  it('/queue lists the pending prompts as the user typed them', async () => {
    mocks.hasQueuedMessages.mockReturnValue(true);
    mocks.getPendingMessages.mockReturnValue([
      // `content` carries the assembled LLM payload (synthetic context
      // prepended); `displayContent` is what the user actually typed. The
      // listing must show the latter — this fixture is only meaningful if
      // the two differ in more than whitespace.
      {
        content: '<synthetic-context>\nworkspace rules\n</synthetic-context>\n\nfirst queued',
        displayContent: 'first queued',
      },
      { content: 'second queued' },
    ]);
    const { bridge } = makeBridge();
    const result = await run('queue', '/queue', bridge);
    expect(result).toEqual({
      type: 'text',
      content: [
        '队列中有 2 条待发消息：',
        '',
        '1. first queued',
        '2. second queued',
        '',
        '/queue clear 清空队列 · /queue resume 说明发送时机',
      ].join('\n'),
    });
    expect((result as { content: string }).content).not.toContain('synthetic-context');
  });

  it('/queue reports an empty queue as text, not an error', async () => {
    mocks.hasQueuedMessages.mockReturnValue(false);
    mocks.getPendingMessages.mockReturnValue([]);
    const { bridge } = makeBridge();
    const result = await run('queue', '/queue', bridge);
    expect(result).toEqual({ type: 'text', content: '队列为空（没有待发消息）。' });
  });

  it('/queue clear drops the queue and the bot-direct wake queue together', async () => {
    mocks.hasQueuedMessages.mockReturnValue(true);
    mocks.resolveChatMode.mockReturnValue('bot-direct');
    const { bridge, toast } = makeBridge();
    expect(await run('queue', '/queue clear', bridge)).toEqual({ type: 'dismiss' });
    expect(mocks.clearQueuedMessages).toHaveBeenCalledWith('s-1');
    expect(mocks.cancelPendingTurnsForSession).toHaveBeenCalledWith('s-1');
    expect(toast).toHaveBeenCalledWith('已清空待发队列', 'success');
  });

  it('/queue clear leaves the bot wake queue alone in a workspace session', async () => {
    mocks.hasQueuedMessages.mockReturnValue(true);
    mocks.resolveChatMode.mockReturnValue('workspace');
    const { bridge } = makeBridge();
    await run('queue', '/queue clear', bridge);
    expect(mocks.clearQueuedMessages).toHaveBeenCalledWith('s-1');
    expect(mocks.cancelPendingTurnsForSession).not.toHaveBeenCalled();
  });

  it('/queue clear on an empty queue never touches the queue', async () => {
    mocks.hasQueuedMessages.mockReturnValue(false);
    const { bridge } = makeBridge();
    const result = await run('queue', '/queue clear', bridge);
    expect(result.type).toBe('text');
    expect(mocks.clearQueuedMessages).not.toHaveBeenCalled();
  });

  it('/queue resume explains the automatic drain rule', async () => {
    mocks.hasQueuedMessages.mockReturnValue(true);
    const { bridge } = makeBridge();
    const result = await run('queue', '/queue resume', bridge);
    expect(result.type).toBe('text');
    expect((result as { content: string }).content).toContain('自动发送');
  });

  it('/queue rejects an unknown subcommand', async () => {
    const { bridge } = makeBridge();
    const result = await run('queue', '/queue purge', bridge);
    expect(result.type).toBe('error');
    expect(mocks.clearQueuedMessages).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Bridge guard
// ---------------------------------------------------------------------------

describe('session executors — missing bridge', () => {
  it('reports an error instead of throwing when no composer is mounted', async () => {
    const executor = SESSION_EXECUTORS.clear;
    const result = await executor({ args: [], raw: '/clear' } as CommandContext);
    expect(result).toEqual({ type: 'error', message: '/clear: app bridge unavailable' });
  });
});

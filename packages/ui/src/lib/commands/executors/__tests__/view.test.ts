/**
 * Executor dispatch tests for the view/feature commands (view.ts).
 *
 * These run against the REAL registry + dispatch table (`runSlashCommand`) so
 * alias resolution and canonical-name lookup are covered, with a fake
 * CommandAppBridge standing in for the composer. Only the three modules view.ts
 * reaches into outside the bridge (the conversation store, the btw store and the
 * SSE client) are mocked — the dispatch decisions are the code under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addProjectFolder: vi.fn(),
  setCurrentView: vi.fn(),
  setSettingsTab: vi.fn(),
  addQuestion: vi.fn(() => 'entry-1'),
  setAnswer: vi.fn(),
  setError: vi.fn(),
  askSideQuestion: vi.fn(async () => ({ id: 'srv-1', answer: 'side answer' })),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: {
    getState: () => ({
      addProjectFolder: mocks.addProjectFolder,
      setCurrentView: mocks.setCurrentView,
      setSettingsTab: mocks.setSettingsTab,
    }),
  },
}));

vi.mock('@/stores/btw-store', () => ({
  useBtwStore: {
    getState: () => ({
      addQuestion: mocks.addQuestion,
      setAnswer: mocks.setAnswer,
      setError: mocks.setError,
    }),
  },
}));

vi.mock('@/lib/agent-sse-client', () => ({
  askSideQuestion: mocks.askSideQuestion,
}));

import { runSlashCommand } from '../registry';
import { setCommandAppBridge, type CommandAppBridge } from '../bridge';
// Side effect: registers every domain's executors, exactly as production does.
import '../index';

function makeBridge(overrides: Partial<CommandAppBridge> = {}): CommandAppBridge {
  return {
    sendPrompt: vi.fn(),
    getSessionSnapshot: () => ({
      sessionId: 'session-1',
      model: 'gpt-5',
      workingDirectory: 'E:\\Projects\\duya',
      messageCount: 4,
    }),
    clearMessages: vi.fn(),
    resetSession: vi.fn(async () => ({ oldSessionId: 'a', newSessionId: 'b' })),
    stopTurn: vi.fn(),
    compactContext: vi.fn(),
    requestRecap: vi.fn(async () => ({ success: true, recap: 'r' })),
    setSessionModel: vi.fn(),
    setEffort: vi.fn(),
    setPermissionMode: vi.fn(),
    toggleMode: vi.fn(),
    openModelPicker: vi.fn(),
    openPanel: vi.fn(),
    promptInput: vi.fn(async () => null),
    toast: vi.fn(),
    ...overrides,
  };
}

let bridge: CommandAppBridge;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.addQuestion.mockReturnValue('entry-1');
  mocks.askSideQuestion.mockResolvedValue({ id: 'srv-1', answer: 'side answer' });
  mocks.addProjectFolder.mockImplementation(async (dir: string) => ({
    workingDirectory: dir,
    projectName: dir.split(/[\\/]/).pop(),
  }));
  bridge = makeBridge();
  setCommandAppBridge(bridge);
});

afterEach(() => {
  setCommandAppBridge(null);
  delete (globalThis as { window?: unknown }).window;
});

describe('/goal', () => {
  it('forwards a control verb verbatim without touching goal mode', async () => {
    // The agent claims status/pause/resume/clear before the model runs; the
    // renderer must not consume the verb or flip the mode chip.
    const result = await runSlashCommand('/goal pause');

    expect(result).toEqual({ type: 'forward', prompt: '/goal pause' });
    expect(bridge.toggleMode).not.toHaveBeenCalled();
  });

  it('enables goal mode for an objective and keeps the objective text', async () => {
    const result = await runSlashCommand('/goal 修复登录 500');

    expect(bridge.toggleMode).toHaveBeenCalledWith('goal');
    // Regression guard: ctx.raw is "/goal" alone, so forwarding it would drop
    // the objective entirely.
    expect(result).toEqual({ type: 'forward', prompt: '/goal 修复登录 500' });
  });

  it('treats a bare /goal as a usage query, not an objective', async () => {
    const result = await runSlashCommand('/goal');

    expect(result).toEqual({ type: 'forward', prompt: '/goal' });
    expect(bridge.toggleMode).not.toHaveBeenCalled();
  });
});

describe('/deep-research', () => {
  it('resolves the research alias, enables research mode and forwards the query', async () => {
    const result = await runSlashCommand('/research 量子计算 退相干');

    expect(bridge.toggleMode).toHaveBeenCalledWith('research');
    // The query alone: `/deep-research` is a desktop command name with no
    // agent-side verb to receive it.
    expect(result).toEqual({ type: 'forward', prompt: '量子计算 退相干' });
  });

  it('enables the mode without starting a turn when no query is given', async () => {
    const result = await runSlashCommand('/deep-research');

    expect(bridge.toggleMode).toHaveBeenCalledWith('research');
    expect(result.type).toBe('text');
  });
});

describe('/diff', () => {
  it('opens the code review panel when the session has a working directory', async () => {
    const result = await runSlashCommand('/diff');

    expect(bridge.openPanel).toHaveBeenCalledWith('code-review');
    expect(result).toEqual({ type: 'dismiss' });
  });

  it('reports instead of silently opening nothing without a working directory', async () => {
    bridge = makeBridge({ getSessionSnapshot: () => ({ sessionId: 'session-1' }) });
    setCommandAppBridge(bridge);

    const result = await runSlashCommand('/diff');

    expect(result.type).toBe('error');
    expect(bridge.openPanel).not.toHaveBeenCalled();
  });
});

describe('/loop', () => {
  it('opens the automation page when bare', async () => {
    const result = await runSlashCommand('/loop');

    expect(bridge.openPanel).toHaveBeenCalledWith('automation');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('automation');
    expect(result).toEqual({ type: 'dismiss' });
  });

  it('explains the creator shape instead of navigating when given arguments', async () => {
    const result = await runSlashCommand('/loop 30m 检查 CI');

    expect(result.type).toBe('text');
    expect(mocks.setCurrentView).not.toHaveBeenCalled();
    expect(bridge.openPanel).not.toHaveBeenCalled();
  });
});

describe('/memory and /mcp', () => {
  it('/memory opens the memory settings tab', async () => {
    const result = await runSlashCommand('/memory');

    expect(bridge.openPanel).toHaveBeenCalledWith('memory');
    expect(mocks.setSettingsTab).toHaveBeenCalledWith('memory');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('settings');
    expect(result).toEqual({ type: 'dismiss' });
  });

  it('/mcp opens the extensions page where MCP servers live', async () => {
    const result = await runSlashCommand('/mcp');

    expect(bridge.openPanel).toHaveBeenCalledWith('mcp');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('extensions');
    expect(result).toEqual({ type: 'dismiss' });
  });
});

describe('/add-dir', () => {
  it('registers a typed path directly, without the picker', async () => {
    const result = await runSlashCommand('/add-dir E:\\Projects\\other');

    expect(mocks.addProjectFolder).toHaveBeenCalledWith('E:\\Projects\\other');
    expect(result.type).toBe('text');
  });

  it('opens the folder picker and registers the chosen directory', async () => {
    const openFolder = vi.fn(async () => ({ canceled: false, filePaths: ['D:\\work\\demo'] }));
    (globalThis as { window?: unknown }).window = { electronAPI: { dialog: { openFolder } } };

    await runSlashCommand('/add-dir');

    expect(openFolder).toHaveBeenCalled();
    expect(mocks.addProjectFolder).toHaveBeenCalledWith('D:\\work\\demo');
  });

  it('does nothing when the picker is cancelled', async () => {
    (globalThis as { window?: unknown }).window = {
      electronAPI: { dialog: { openFolder: vi.fn(async () => ({ canceled: true, filePaths: [] })) } },
    };

    const result = await runSlashCommand('/add-dir');

    expect(mocks.addProjectFolder).not.toHaveBeenCalled();
    expect(result).toEqual({ type: 'dismiss' });
  });
});

describe('/image', () => {
  it('forwards the prompt with an image_generate instruction', async () => {
    const result = await runSlashCommand('/image 一只橘猫');

    expect(result).toEqual({
      type: 'forward',
      prompt: '请使用 image_generate 工具生成图片。提示词：一只橘猫',
    });
  });

  it('shows usage instead of sending an empty generation request', async () => {
    const result = await runSlashCommand('/image');

    expect(result.type).toBe('text');
  });
});

describe('/btw', () => {
  it('asks a side question and records it in the btw store', async () => {
    const result = await runSlashCommand('/btw 这个函数是干什么的');

    expect(mocks.askSideQuestion).toHaveBeenCalledWith('session-1', '这个函数是干什么的');
    expect(mocks.addQuestion).toHaveBeenCalledWith('session-1', '这个函数是干什么的');
    expect(mocks.setAnswer).toHaveBeenCalledWith('session-1', 'entry-1', 'side answer');
    expect(result).toEqual({ type: 'text', content: 'side answer' });
  });

  it('marks the stored entry as failed and reports the error', async () => {
    mocks.askSideQuestion.mockRejectedValueOnce(new Error('boom'));

    const result = await runSlashCommand('/btw 问题');

    expect(mocks.setError).toHaveBeenCalledWith('session-1', 'entry-1', 'boom');
    expect(result).toEqual({ type: 'error', message: 'boom' });
  });

  it('refuses without a session instead of calling the side endpoint', async () => {
    bridge = makeBridge({ getSessionSnapshot: () => ({}) });
    setCommandAppBridge(bridge);

    const result = await runSlashCommand('/btw 问题');

    expect(result.type).toBe('error');
    expect(mocks.askSideQuestion).not.toHaveBeenCalled();
  });

  it('prompts for the question when none is typed, and dismisses on cancel', async () => {
    bridge = makeBridge({ promptInput: vi.fn(async () => '取消前的输入') });
    setCommandAppBridge(bridge);

    await runSlashCommand('/btw');
    expect(mocks.askSideQuestion).toHaveBeenCalledWith('session-1', '取消前的输入');

    bridge = makeBridge({ promptInput: vi.fn(async () => null) });
    setCommandAppBridge(bridge);
    const result = await runSlashCommand('/btw');

    expect(result).toEqual({ type: 'dismiss' });
  });
});

/**
 * Executor dispatch tests for the surface commands (apps / plugin / workflow)
 * and the desktop handoff (/app).
 *
 * These drive the domain executors directly, the way `session.test.ts` does:
 * the shared catalog does not name these commands yet, and the dispatch table
 * is what is under test — which view the command opens, what it tells the
 * user, and what it refuses to do on a surface that cannot serve it.
 *
 * The modules that own live state (the conversation store, the UI services
 * registry, the SSE client and the session queue) are replaced; the
 * decisions are the code under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandAppBridge } from '../bridge';
import type { CommandContext, CommandResult } from '../../types';

const mocks = vi.hoisted(() => ({
  setCurrentView: vi.fn(),
  setActiveThread: vi.fn(),
  peekUiServices: vi.fn(() => null as { capabilities: { extensions?: boolean; workflows?: boolean } } | null),
  focusSession: vi.fn(),
  toast: vi.fn(),
  dispatchEvent: vi.fn(),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: {
    getState: () => ({
      setCurrentView: mocks.setCurrentView,
      setActiveThread: mocks.setActiveThread,
    }),
  },
}));

vi.mock('@/services', () => ({ peekUiServices: mocks.peekUiServices }));

vi.mock('@/stores/btw-store', () => ({
  useBtwStore: {
    getState: () => ({ addQuestion: vi.fn(), setAnswer: vi.fn(), setError: vi.fn() }),
  },
}));

vi.mock('@/lib/agent-sse-client', () => ({ askSideQuestion: vi.fn() }));

vi.mock('@/lib/stream-session-manager', () => ({
  clearQueuedMessages: vi.fn(),
  getPendingMessages: vi.fn(() => []),
  hasQueuedMessages: vi.fn(() => false),
}));

vi.mock('@/lib/ipc-client', () => ({ exportRolloutIPC: vi.fn() }));

vi.mock('@/components/chat/bot/chat-mode', () => ({
  resolveChatMode: vi.fn(() => 'workspace'),
}));

vi.mock('@/components/chat/bot/send/scheduled-turns', () => ({
  cancelPendingTurnsForSession: vi.fn(),
}));

const { EXTENSION_EXECUTORS } = await import('../extensions');
const { VIEW_EXECUTORS } = await import('../view');
const { SESSION_EXECUTORS } = await import('../session');

type Executor = (ctx: CommandContext) => CommandResult | Promise<CommandResult>;

function makeBridge(overrides: Partial<CommandAppBridge> = {}): CommandAppBridge {
  return {
    sendPrompt: vi.fn(),
    getSessionSnapshot: () => ({ sessionId: 's-1' }),
    clearMessages: vi.fn(),
    resetSession: vi.fn(async () => ({ oldSessionId: 's-1', newSessionId: 's-2' })),
    stopTurn: vi.fn(),
    compactContext: vi.fn(),
    focusSession: mocks.focusSession,
    requestRecap: vi.fn(async () => ({ success: true, recap: 'r' })),
    setSessionModel: vi.fn(),
    setEffort: vi.fn(),
    setPermissionMode: vi.fn(),
    toggleMode: vi.fn(),
    openModelPicker: vi.fn(),
    openPanel: vi.fn(),
    promptInput: vi.fn(async () => null),
    toast: mocks.toast,
    ...overrides,
  };
}

function run(executor: Executor | undefined, bridge: CommandAppBridge | null): Promise<CommandResult> {
  if (!executor) throw new Error('executor not found');
  return Promise.resolve(executor({ args: [], raw: '/x', app: bridge ?? undefined } as CommandContext));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.peekUiServices.mockReturnValue(null);
  (globalThis as { window?: unknown }).window = { dispatchEvent: mocks.dispatchEvent };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('/apps', () => {
  it('opens the extensions surface and says where the connections live', async () => {
    const result = await run(EXTENSION_EXECUTORS.apps, makeBridge());

    expect(result.type).toBe('dismiss');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('extensions');
    // The page keeps its tab in component state, so the command states which
    // tab it means.
    expect(mocks.dispatchEvent).toHaveBeenCalledTimes(1);
    const event = mocks.dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{ tab: string }>;
    expect(event.type).toBe('duya:open-extensions-tab');
    expect(event.detail).toEqual({ tab: 'installed' });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('refuses on a surface without extensions instead of opening nothing', async () => {
    mocks.peekUiServices.mockReturnValue({ capabilities: { extensions: false } });

    const result = await run(EXTENSION_EXECUTORS.apps, makeBridge());

    expect(result.type).toBe('error');
    expect(mocks.setCurrentView).not.toHaveBeenCalled();
  });

  it('reports a missing bridge', async () => {
    const result = await run(EXTENSION_EXECUTORS.apps, null);

    expect(result.type).toBe('error');
  });
});

describe('/plugin', () => {
  it('opens the extensions surface on the marketplace', async () => {
    const result = await run(EXTENSION_EXECUTORS.plugin, makeBridge());

    expect(result.type).toBe('dismiss');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('extensions');
  });

  it('refuses on a surface without extensions', async () => {
    mocks.peekUiServices.mockReturnValue({ capabilities: { extensions: false } });

    const result = await run(EXTENSION_EXECUTORS.plugin, makeBridge());

    expect(result.type).toBe('error');
    expect(mocks.setCurrentView).not.toHaveBeenCalled();
  });
});

describe('/workflow', () => {
  it('opens the workflow page', async () => {
    const result = await run(VIEW_EXECUTORS.workflow, makeBridge());

    expect(result.type).toBe('dismiss');
    expect(mocks.setCurrentView).toHaveBeenCalledWith('workflow');
  });

  it('refuses on a surface without workflows', async () => {
    mocks.peekUiServices.mockReturnValue({ capabilities: { workflows: false } });

    const result = await run(VIEW_EXECUTORS.workflow, makeBridge());

    expect(result.type).toBe('error');
    expect(mocks.setCurrentView).not.toHaveBeenCalled();
  });
});

describe('/app', () => {
  it('brings the current session to the foreground', async () => {
    const result = await run(SESSION_EXECUTORS.app, makeBridge());

    expect(result.type).toBe('dismiss');
    expect(mocks.focusSession).toHaveBeenCalledWith('s-1');
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it('refuses when there is no session to open', async () => {
    const bridge = makeBridge({ getSessionSnapshot: () => ({}) });

    const result = await run(SESSION_EXECUTORS.app, bridge);

    expect(result.type).toBe('error');
    expect(mocks.focusSession).not.toHaveBeenCalled();
  });

  it('reports a missing bridge', async () => {
    const result = await run(SESSION_EXECUTORS.app, null);

    expect(result.type).toBe('error');
  });
});

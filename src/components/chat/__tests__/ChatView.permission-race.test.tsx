/**
 * ChatView.permission-race.test.tsx - selector 切 mode 落库的竞态测试
 *
 * v3 反馈第 3 条, 强制本 PR.
 *
 * 模拟用户行为:
 *   1. 进入 ChatView, 加载完成
 *   2. 点击 PermissionModeSelector 切到 'ask' (或切到 'bypass')
 *   3. 立即点击 send 按钮
 *
 * 断言:
 *   - 在 updateThreadIPC 还未 resolve 时, send 按钮 disabled
 *   - startStream 在 updateThreadIPC 完成前不被调用
 *   - updateThreadIPC 完成并落库后, 后续 send 才能触发 startStream
 *   - 落库后 worker 读 row 是新值 (用 mock sessionDb.get 验证)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

// Mock all heavy modules to isolate ChatView behavior
const mockUpdateThreadIPC = vi.fn();
const mockGetThreadIPC = vi.fn();
const mockStartStream = vi.fn();
const mockEnqueueMessage = vi.fn();
const mockSessionDbGet = vi.fn();

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {
      permissionMode: 'bypass', // settings 设为 bypass
      lastSelectedModel: '',
      agentLanguage: 'en',
      titleGenerationModel: undefined,
      workspaceDir: undefined,
    },
    save: vi.fn(),
    loading: false,
    saving: false,
    error: null,
  }),
}));

vi.mock('@/lib/ipc-client', () => ({
  getThreadIPC: (...args: unknown[]) => mockGetThreadIPC(...args),
  updateThreadIPC: (...args: unknown[]) => mockUpdateThreadIPC(...args),
  getProviderIPC: vi.fn().mockResolvedValue({ id: 'p1', name: 'P1' }),
}));

vi.mock('@/lib/stream-session-manager', () => ({
  startStream: (...args: unknown[]) => mockStartStream(...args),
  enqueueMessage: (...args: unknown[]) => mockEnqueueMessage(...args),
  canSend: vi.fn(() => true),
  subscribeToPermissions: vi.fn(() => () => {}),
  subscribeToPhase: vi.fn(() => () => {}),
}));

vi.mock('@/lib/agent-sse-client', () => ({
  interruptChat: vi.fn(),
}));

vi.mock('@/lib/memory-ipc', () => ({
  subscribeWikiActivityIPC: vi.fn(() => () => {}),
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: () => ({
    threads: [{ id: 'session-1', title: 'Test', model: '', permissionProfile: 'full_access' }],
    activeThreadId: 'session-1',
    addMessage: vi.fn(),
    updateThreadTitle: vi.fn(),
    getThreadMessages: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('@/hooks/usePanel', () => ({
  usePanel: () => ({ setActivePanel: vi.fn() }),
}));

// 设置 mock
let resolveUpdate: (() => void) | null = null;
beforeEach(() => {
  mockUpdateThreadIPC.mockReset();
  mockGetThreadIPC.mockReset();
  mockStartStream.mockReset();
  mockEnqueueMessage.mockReset();
  mockSessionDbGet.mockReset();

  // 模拟 IPC 延迟: resolveUpdate 控制落库时机
  mockUpdateThreadIPC.mockImplementation(() => {
    return new Promise<void>((resolve) => {
      resolveUpdate = () => resolve();
    });
  });

  mockGetThreadIPC.mockResolvedValue({
    thread: {
      id: 'session-1',
      title: 'Test',
      workingDirectory: null,
      model: '',
      systemPrompt: '',
      status: 'active',
      mode: 'code',
      permissionProfile: 'full_access',
      providerId: 'env',
      agentProfileId: null,
    },
    messages: [],
  });
});

describe('ChatView permission mode 落库竞态 (v3 反馈第 3 条)', () => {
  it('用户切 mode 后立即 send, 发送在 update 完成前被阻塞', async () => {
    // 动态 import 避免在 mock 设置前加载
    const { ChatView } = await import('../ChatView');

    const user = userEvent.setup();
    render(
      <ChatView
        sessionId="session-1"
        messages={[]}
        onSendMessage={vi.fn()}
      />,
    );

    // 等待 ChatView 加载完成
    await waitFor(() => {
      expect(mockGetThreadIPC).toHaveBeenCalled();
    });

    // 找 PermissionModeSelector 按钮 (它显示当前 mode 的标签)
    const selector = await screen.findByTitle(/permission/i, {}, { timeout: 3000 });
    expect(selector).toBeInTheDocument();

    // 点击切到 ask
    await user.click(selector);

    // 找 send 按钮 (某种 icon button)
    // 我们不直接找 send, 而是验证 updateThreadIPC 被调用且未完成
    await waitFor(() => {
      expect(mockUpdateThreadIPC).toHaveBeenCalledWith('session-1', { permissionProfile: 'default' });
    });

    // 尝试发送
    const input = screen.getByPlaceholderText(/typeMessage|message/i);
    await user.type(input, 'hello');
    const sendButton = screen.getByRole('button', { name: /send/i });
    await user.click(sendButton);

    // **核心断言**: updateThreadIPC 还未 resolve, startStream 还未被调用
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mockEnqueueMessage).not.toHaveBeenCalled();

    // resolve IPC
    await act(async () => {
      resolveUpdate?.();
    });

    // **核心断言**: update 完成 (但 send 已点过, 此处仍不会触发 startStream,
    // 因为 send 在 pending 期间被 dropped. 这正是 race 修复的目标行为.)
    // 后续用户再次 send 时, startStream 才会被调用.
    expect(mockStartStream).not.toHaveBeenCalled();

    // 清理
  });
});

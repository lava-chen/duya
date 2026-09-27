// Reproduction test for the NewChatView mode drop: select a mode in the
// new-chat composer, send, and assert the mode reaches onSendMessage.
// Uses the real MessageInput + NewChatView; mocks the surrounding IO.
// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const onSendMessage = vi.fn();

const mocks = vi.hoisted(() => {
  const storeState = {
    projects: [{ workingDirectory: 'C:/proj', projectName: 'proj' }],
    isHydrated: true,
    newChatDraft: { text: '', attachments: [], hasContent: false },
    newChatPresetProject: null,
    createThread: vi.fn(async () => ({ id: 'thread-1', title: 'New chat' })),
    setActiveThread: vi.fn(async () => undefined),
    addProjectFolder: vi.fn(),
    updateNewChatDraft: vi.fn(),
    clearNewChatDraft: vi.fn(),
    clearNewChatPresetProject: vi.fn(),
    setThreadPlanMode: vi.fn(),
    setThreadGoalMode: vi.fn(),
  };
  const useConversationStoreMock = Object.assign(
    (selector: (s: unknown) => unknown) => selector(storeState),
    { getState: () => storeState },
  );
  const setPlanMode = vi.fn(async () => undefined);
  const setGoalMode = vi.fn(async () => undefined);
  return { storeState, useConversationStoreMock, setPlanMode, setGoalMode };
});

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: mocks.useConversationStoreMock,
}));

// Session-level mode persistence (plan 413e) — NewChatView writes the
// extension flags through these preload channels on the first send.
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { session: { setPlanMode: mocks.setPlanMode, setGoalMode: mocks.setGoalMode } },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: 'en' }),
}));

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({ settings: {}, save: vi.fn(async () => undefined) }),
}));

vi.mock('@/lib/ipc-client', () => ({
  getActiveProviderIPC: vi.fn(async () => null),
  listProvidersIPC: vi.fn(async () => []),
  updateThreadIPC: vi.fn(async () => undefined),
  saveDraftIPC: vi.fn(async () => undefined),
  getDraftIPC: vi.fn(async () => null),
  listOutputStylesIPC: vi.fn(async () => []),
}));

vi.mock('@/components/home/SessionSelector', () => ({
  SessionSelector: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/InputDialog', () => ({
  InputDialog: () => null,
}));

vi.mock('@/hooks/useAttachments', () => ({
  makeFileTreeRefAttachment: vi.fn(),
  useAttachments: () => ({
    attachments: [],
    parseErrors: [],
    isParsing: false,
    addAttachment: vi.fn(),
    addPastedText: vi.fn(),
    addFile: vi.fn(async () => undefined),
    addBrowserScreenshot: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    buildModelContent: (v: string) => v,
    buildDisplayContent: (v: string) => v,
    hasUnparsedDocs: false,
  }),
}));

vi.mock('@/lib/mcp-inventory-ipc', () => ({
  fetchMCPInventorySnapshot: vi.fn(async () => null),
}));

vi.mock('@/lib/providers/models/ModelCapabilityService', () => ({
  modelCapabilityService: {
    getModelCapability: vi.fn(() => null),
  },
}));

vi.mock('@/lib/code-comment-store', () => ({
  buildCodeCommentsPromptBlock: vi.fn(() => ''),
  markCodeCommentsSent: vi.fn(),
}));

vi.mock('@duya/ai', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEffortOptionsForCapability: vi.fn(() => []),
  getEffortOptionsForModel: vi.fn(() => null),
}));

vi.mock('./AttachmentBar', () => ({ AttachmentBar: () => null }));
vi.mock('./CodeCommentStrip', () => ({ CodeCommentStrip: () => null }));
vi.mock('./BackgroundTasksIndicator', () => ({ BackgroundTasksIndicator: () => null }));
vi.mock('./ModelProviderSelector', () => ({ ModelProviderSelector: () => null }));
vi.mock('./ContextUsageRing', () => ({
  ContextUsageRing: () => null,
  ContextUsagePanel: () => null,
}));

import { NewChatView } from './NewChatView';

describe('NewChatView mode passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  async function sendWithMode(modeLabel: string) {
    render(<NewChatView onSendMessage={onSendMessage} />);

    // Open the "@" context popover via the plus button.
    const plus = screen.getByLabelText('common.settings');
    fireEvent.click(plus);

    // Pick the mode item. Real browsers fire mousedown before click —
    // replicate that ordering so any outside-close trap would trigger.
    const item = await screen.findByText(modeLabel);
    fireEvent.mouseDown(item);
    fireEvent.mouseUp(item);
    fireEvent.click(item);

    // Type a message and submit. The composer is a contenteditable div
    // (RichTextInput) that emits onChange on the DOM input event.
    const editable = document.querySelector('[contenteditable="true"], [contenteditable=true]') as HTMLElement
      ?? (document.querySelector('[contenteditable]') as HTMLElement);
    expect(editable).toBeTruthy();
    editable.textContent = 'hello with mode';
    fireEvent.input(editable);
    const form = editable.closest('form') as HTMLFormElement;
    fireEvent.submit(form);

    // NewChatView hands off via a double rAF after setActiveThread.
    await waitFor(() => expect(onSendMessage).toHaveBeenCalled(), { timeout: 3000 });
    return onSendMessage.mock.calls[0] as unknown[];
  }

  it('plan-task mode reaches onSendMessage', async () => {
    const args = await sendWithMode('Plan Mode');
    // App.handleSendMessage signature: content, model, files, agentProfileId,
    // outputStyleConfig, mode, effort, displayContent, conductorMode, ...
    expect(args[5]).toBe('plan-task');
    // Session-level mode is persisted so ChatView restores the chip and
    // later turns keep the mode after the view switch.
    expect(mocks.setPlanMode).toHaveBeenCalledWith('thread-1', true);
    expect(mocks.storeState.setThreadPlanMode).toHaveBeenCalledWith('thread-1', true);
  });

  it('computer-use mode reaches onSendMessage', async () => {
    const args = await sendWithMode('Computer Use');
    expect(args[5]).toBe('computer-use');
  });

  it('goal mode reaches onSendMessage and persists', async () => {
    const args = await sendWithMode('Goal');
    expect(args[5]).toBe('goal');
    expect(mocks.setGoalMode).toHaveBeenCalledWith('thread-1', true);
    expect(mocks.storeState.setThreadGoalMode).toHaveBeenCalledWith('thread-1', true);
  });
});

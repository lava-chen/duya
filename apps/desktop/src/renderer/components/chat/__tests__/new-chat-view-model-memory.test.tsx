/**
 * NewChatView composer model-memory regression tests.
 *
 * Reported bug: the new-chat composer always showed the provider's default
 * model instead of the model the user picked last time, even though the pick
 * was persisted to settings.lastSelectedModel.
 *
 * Root cause: the seeding effect raced against settings loading. Settings
 * arrive over several sequential IPC round-trips (getAllSettings → vision →
 * mcpServers) while the provider-default seed needs a single IPC, so the
 * default was seeded first and the `if (sessionModel) return` guard then
 * rejected settings.lastSelectedModel forever.
 *
 * The fix gates the whole effect on `settingsLoading`. These tests lock the
 * restore order — remembered model (existing provider) > provider default —
 * regardless of IPC arrival order.
 *
 * @vitest-environment jsdom
 */

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const settingsMock = vi.hoisted(() => ({
  settings: { lastSelectedModel: '' } as Record<string, unknown>,
  loading: true,
  save: vi.fn(async () => {}),
}));

const ipcMock = vi.hoisted(() => ({
  getActiveProviderIPC: vi.fn(),
  listProvidersIPC: vi.fn(),
  updateThreadIPC: vi.fn(async () => ({})),
}));

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: settingsMock.settings,
    loading: settingsMock.loading,
    saving: false,
    error: null,
    save: settingsMock.save,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock('@/lib/ipc-client', () => ipcMock);

vi.mock('@/lib/providers', () => ({
  isKeylessLocalProvider: () => false,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/stores/conversation-store', () => {
  const state = {
    projects: [],
    isHydrated: true,
    newChatDraft: { text: '', attachments: [], hasContent: false },
    newChatPresetProject: null,
    createThread: vi.fn(async () => null),
    setActiveThread: vi.fn(),
    addProjectFolder: vi.fn(),
    updateNewChatDraft: vi.fn(),
    clearNewChatDraft: vi.fn(),
    clearNewChatPresetProject: vi.fn(),
  };
  const useConversationStore = (selector?: (s: typeof state) => unknown) =>
    typeof selector === 'function' ? selector(state) : state;
  useConversationStore.getState = () => state;
  return { useConversationStore };
});

vi.mock('@/components/home/SessionSelector', () => ({
  SessionSelector: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/InputDialog', () => ({
  InputDialog: () => null,
}));

vi.mock('../AgentModeSelector', () => ({
  getProfileIdForMode: () => 'general-purpose',
}));

// The stub surfaces the two values under test: the model shown in the
// picker (data-model) and the user-pick callback (click).
vi.mock('../MessageInput', () => ({
  MessageInput: (props: Record<string, unknown>) => (
    <div
      data-testid="message-input"
      data-model={String(props.modelName ?? '')}
      onClick={() =>
        (props.onModelChange as ((m: string, p?: string) => void) | undefined)?.(
          '[Acme] model-b',
          'prov-acme',
        )
      }
    />
  ),
}));

import { NewChatView } from '../NewChatView';

const flush = () => act(async () => {});

const DEFAULT_PROVIDER = {
  id: 'prov-default',
  name: 'DefaultCo',
  providerType: 'openai',
  hasApiKey: true,
  baseUrl: '',
  options: JSON.stringify({ enabled_models: ['model-a'] }),
  defaultModel: '',
};

describe('NewChatView composer model memory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMock.loading = true;
    settingsMock.settings = { lastSelectedModel: '' };
    ipcMock.getActiveProviderIPC.mockResolvedValue(DEFAULT_PROVIDER);
    ipcMock.listProvidersIPC.mockResolvedValue([
      { id: 'prov-default', name: 'DefaultCo' },
      { id: 'prov-acme', name: 'Acme' },
    ]);
  });

  it('seeds nothing while settings are still loading (no premature default)', async () => {
    const { getByTestId } = render(<NewChatView onSendMessage={vi.fn()} />);
    await flush();
    await flush();
    expect(getByTestId('message-input').getAttribute('data-model')).toBe('');
  });

  it('adopts the remembered model when settings arrive after mount (the reported race)', async () => {
    const { getByTestId, rerender } = render(<NewChatView onSendMessage={vi.fn()} />);
    await flush();

    // Settings arrive AFTER the composer mounted — the exact timing that
    // used to lose to the provider-default seed.
    settingsMock.loading = false;
    settingsMock.settings = { lastSelectedModel: '[Acme] model-b' };
    rerender(<NewChatView onSendMessage={vi.fn()} />);
    await flush();
    await flush();

    expect(getByTestId('message-input').getAttribute('data-model')).toBe('[Acme] model-b');
  });

  it('falls back to the provider default when no model was remembered', async () => {
    settingsMock.loading = false;
    const { getByTestId } = render(<NewChatView onSendMessage={vi.fn()} />);
    await flush();
    await flush();
    expect(getByTestId('message-input').getAttribute('data-model')).toBe('[DefaultCo] model-a');
  });

  it('falls back to the provider default when the remembered provider no longer exists', async () => {
    settingsMock.loading = false;
    settingsMock.settings = { lastSelectedModel: '[Ghost] model-x' };
    const { getByTestId } = render(<NewChatView onSendMessage={vi.fn()} />);
    await flush();
    await flush();
    expect(getByTestId('message-input').getAttribute('data-model')).toBe('[DefaultCo] model-a');
  });

  it('persists a manual model pick via settings.save', async () => {
    settingsMock.loading = false;
    const { getByTestId } = render(<NewChatView onSendMessage={vi.fn()} />);
    await flush();
    await flush();

    fireEvent.click(getByTestId('message-input'));

    expect(settingsMock.save).toHaveBeenCalledWith({ lastSelectedModel: '[Acme] model-b' });
    expect(getByTestId('message-input').getAttribute('data-model')).toBe('[Acme] model-b');
  });
});

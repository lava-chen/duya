/**
 * Regression test for "new thread always used the provider default model".
 *
 * Threads created without an explicit model/provider (sidebar "+" no-project
 * thread, project-group "new thread") fell through to the active provider's
 * default, ignoring the model the user last picked in a composer
 * (settings.lastSelectedModel, stored as "[ProviderName] modelId").
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  providers: [] as Array<Record<string, unknown>>,
  createThreadIPC: vi.fn(async () => ({ id: 'db-row' })),
  getNoProjectWorkspaceIPC: vi.fn(async () => '/tmp/duya-workspace'),
  getActiveProviderIPC: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
}));

vi.mock('@/lib/ipc-client', () => ({
  listThreadsIPC: vi.fn(async () => []),
  getThreadIPC: vi.fn(async () => null),
  createThreadIPC: mocks.createThreadIPC,
  deleteThreadIPC: vi.fn(),
  archiveThreadIPC: vi.fn(),
  unarchiveThreadIPC: vi.fn(),
  listArchivedThreadsIPC: vi.fn(async () => []),
  getProjectGroupsIPC: vi.fn(async () => []),
  getNoProjectWorkspaceIPC: mocks.getNoProjectWorkspaceIPC,
  addRecentFolderIPC: vi.fn(),
  addMessageIPC: vi.fn(),
  getActiveProviderIPC: mocks.getActiveProviderIPC,
  getAllSettingsIPC: vi.fn(async () => mocks.settings),
  listProvidersIPC: vi.fn(async () => mocks.providers),
  updateThreadIPC: vi.fn(async () => ({})),
  truncateMessagesAfterIPC: vi.fn(),
  truncateMessagesFromInclusiveIPC: vi.fn(),
}));

vi.mock('@/lib/agent-http-client', () => ({
  getAgentServerClient: vi.fn(() => ({})),
}));

import { useConversationStore } from '../conversation-store';

const DEFAULT_PROVIDER = {
  id: 'prov-default',
  name: 'DefaultCo',
  providerType: 'openai',
  hasApiKey: true,
  baseUrl: '',
  options: JSON.stringify({ enabled_models: ['model-a'] }),
  defaultModel: '',
};

describe('createThread remembered-model fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = {};
    mocks.providers = [
      { id: 'prov-default', name: 'DefaultCo' },
      { id: 'prov-acme', name: 'Acme' },
    ];
    mocks.getActiveProviderIPC.mockResolvedValue(DEFAULT_PROVIDER);
  });

  it('applies lastSelectedModel when creating a no-project thread', async () => {
    mocks.settings = { lastSelectedModel: '[Acme] model-b' };

    const thread = await useConversationStore.getState().createThread({ noProject: true });

    expect(thread?.providerId).toBe('prov-acme');
    expect(thread?.model).toBe('model-b');
  });

  it('falls back to the active provider default when the remembered provider is gone', async () => {
    mocks.settings = { lastSelectedModel: '[Ghost] model-x' };

    const thread = await useConversationStore.getState().createThread({ noProject: true });

    expect(thread?.providerId).toBe('prov-default');
    expect(thread?.model).toBe('model-a');
  });

  it('keeps an explicitly provided model untouched', async () => {
    mocks.settings = { lastSelectedModel: '[Acme] model-b' };

    const thread = await useConversationStore.getState().createThread({
      noProject: true,
      providerId: 'prov-default',
      model: 'explicit-model',
    });

    expect(thread?.providerId).toBe('prov-default');
    expect(thread?.model).toBe('explicit-model');
  });
});

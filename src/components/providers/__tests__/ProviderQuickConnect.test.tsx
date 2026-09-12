/**
 * src/components/providers/__tests__/ProviderQuickConnect.test.tsx
 *
 * Quick-connect panel contract tests:
 *  - Add mode renders the single API key input + preset model
 *    preview; submitting without a key surfaces the required
 *    error and does not save.
 *  - Save payload carries the preset defaults (preset_id as the
 *    stable id, all defaultModels enabled, first as defaultModel,
 *    baseUrl + env overrides from the preset).
 *  - Update mode seeds the masked key (3-state 'untouched') so
 *    the save sends `api_key: undefined` with the existing
 *    provider id — same contract as `ProviderEditView`.
 *  - The picker routes simple presets to the quick panel and
 *    advanced presets (extra_env / model_names / model_mapping)
 *    straight to the full edit page.
 *
 * All credential-looking strings below are inert placeholders:
 * the renderer only ever receives masked hints, and the save
 * layer is mocked.
 */

// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderQuickConnect } from '../ProviderQuickConnect';
import { ProviderPickerView } from '../ProviderPickerView';
import { useConversationStore } from '@/stores/conversation-store';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import type { QuickPreset } from '@/lib/provider-presets';

const saveMock = vi.fn().mockResolvedValue({});
vi.mock('@/lib/providers/hooks/useProviderEditSave', () => ({
  useProviderEditSave: () => ({
    save: (...args: unknown[]) => saveMock(...args),
    isPending: false,
    error: null,
  }),
}));

vi.mock('@/lib/providers/hooks/useOpenExternal', () => ({
  useOpenExternal: () => vi.fn(),
}));

vi.mock('@/lib/ipc-client', () => ({
  testProviderIPC: vi.fn().mockResolvedValue({
    success: false,
    error: { code: 'NO_CREDENTIALS', message: 'no key', suggestion: '' },
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
  }),
}));

vi.mock('@/components/icons', () => {
  const Stub = (props: { size?: number; className?: string }) =>
    React.createElement('svg', { 'data-testid': 'icon', ...props });
  const out: Record<string, unknown> = {};
  const names = [
    'SpinnerGapIcon',
    'CheckCircleIcon',
    'XCircleIcon',
    'CircleNotchIcon',
    'ArrowLeftIcon',
    'ArrowUpRightIcon',
    'EyeIcon',
    'EyeSlashIcon',
    'PlusIcon',
  ];
  for (const n of names) out[n] = Stub;
  return out;
});

vi.mock('@/components/settings/PresetIcon', () => ({
  PresetIcon: () =>
    React.createElement('div', { 'data-testid': 'preset-icon' }),
}));

/** Inert masked hint, as the renderer receives from IPC. */
const MASKED_HINT = 'mask***hint';
/** Inert stand-in for a user-typed replacement key. */
const TYPED_KEY = 'user-typed-value';

const DEEPSEEK_PRESET: QuickPreset = {
  key: 'deepseek',
  name: 'DeepSeek',
  description: 'DeepSeek',
  descriptionZh: 'DeepSeek Anthropic 兼容 API',
  protocol: 'anthropic',
  authStyle: 'auth_token',
  baseUrl: 'https://api.deepseek.com/anthropic',
  defaultEnvOverrides: { API_TIMEOUT_MS: '3000000' },
  defaultModels: [
    { modelId: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash' },
    { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
  ],
  fields: ['api_key'],
  iconKey: 'deepseek',
  provider_type: 'anthropic',
};

function makeProvider(
  overrides: Partial<RendererLlmProviderDTO> = {},
): RendererLlmProviderDTO {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    alias: '',
    category: 'official',
    apiFormat: 'anthropic',
    apiKey: MASKED_HINT,
    hasApiKey: true,
    baseUrl: 'https://api.deepseek.com/anthropic',
    sortOrder: 0,
    isDefault: false,
    isActive: true,
    notes: '',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    extraEnv: '{"API_TIMEOUT_MS":"3000000"}',
    headers: '{}',
    options: '{"enabled_models":["deepseek-v4-pro"]}',
    protocol: 'anthropic',
    legacy: { providerType: 'anthropic', providerTypeMapping: 'direct' },
    ...overrides,
  };
}

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, qc };
}

describe('ProviderQuickConnect — add mode', () => {
  beforeEach(() => {
    saveMock.mockClear();
    saveMock.mockResolvedValue({});
  });

  it('renders the key input and preset model preview', () => {
    const { wrapper } = makeWrapper();
    render(
      <ProviderQuickConnect
        preset={DEEPSEEK_PRESET}
        onBack={vi.fn()}
        onAdvanced={vi.fn()}
        onConnected={vi.fn()}
      />,
      { wrapper },
    );

    expect(
      screen.getByTestId('provider-quick-connect-model-deepseek-v4-pro'),
    ).toBeDefined();
    expect(screen.getByTestId('provider-quick-connect-submit')).toBeDefined();
    // No "configured" badge in add mode.
    expect(screen.queryByText('provider.configured')).toBeNull();
  });

  it('blocks save and shows the required error when the key is empty', async () => {
    const { wrapper } = makeWrapper();
    const onConnected = vi.fn();
    render(
      <ProviderQuickConnect
        preset={DEEPSEEK_PRESET}
        onBack={vi.fn()}
        onAdvanced={vi.fn()}
        onConnected={onConnected}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByTestId('provider-quick-connect-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('provider-quick-connect-error')).toBeDefined();
    });
    expect(screen.getByTestId('provider-quick-connect-error').textContent).toBe(
      'provider.apiKeyRequired',
    );
    expect(saveMock).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('saves with the preset defaults and routes to the list on success', async () => {
    const { wrapper } = makeWrapper();
    const onConnected = vi.fn();
    render(
      <ProviderQuickConnect
        preset={DEEPSEEK_PRESET}
        onBack={vi.fn()}
        onAdvanced={vi.fn()}
        onConnected={onConnected}
      />,
      { wrapper },
    );

    // The API key input is the only password input on the page.
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: TYPED_KEY } });
    fireEvent.click(screen.getByTestId('provider-quick-connect-submit'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const [data, editingId] = saveMock.mock.calls[0] as [
      Record<string, unknown>,
      string | null,
    ];
    expect(editingId).toBeNull();
    expect(data.preset_id).toBe('deepseek');
    expect(data.name).toBe('DeepSeek');
    expect(data.base_url).toBe('https://api.deepseek.com/anthropic');
    expect(data.api_key).toBe(TYPED_KEY);
    expect(data.enabled_models).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
    ]);
    expect(data.options).toEqual({
      enabled_models: ['deepseek-flash', 'deepseek-v4-pro'],
      defaultModel: 'deepseek-flash',
    });
    expect(data.extra_env).toBe('{"API_TIMEOUT_MS":"3000000"}');
    await waitFor(() => {
      expect(onConnected).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ProviderQuickConnect — update mode', () => {
  beforeEach(() => {
    saveMock.mockClear();
    saveMock.mockResolvedValue({});
  });

  it('seeds the masked key and saves untouched with the existing id', async () => {
    const { wrapper } = makeWrapper();
    const existing = makeProvider();
    render(
      <ProviderQuickConnect
        preset={DEEPSEEK_PRESET}
        existingProvider={existing}
        onBack={vi.fn()}
        onAdvanced={vi.fn()}
        onConnected={vi.fn()}
      />,
      { wrapper },
    );

    // Configured badge + masked hint visible.
    expect(screen.getByText('provider.configured')).toBeDefined();
    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(input.value).toBe(MASKED_HINT);

    fireEvent.click(screen.getByTestId('provider-quick-connect-submit'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const [data, editingId] = saveMock.mock.calls[0] as [
      Record<string, unknown>,
      string | null,
    ];
    // 3-state 'untouched' → keep the on-disk key.
    expect(data.api_key).toBeUndefined();
    expect(editingId).toBe('deepseek');
    // Existing env survives the save.
    expect(data.extra_env).toBe('{"API_TIMEOUT_MS":"3000000"}');
  });

  it('forwards retyped keys verbatim', async () => {
    const { wrapper } = makeWrapper();
    render(
      <ProviderQuickConnect
        preset={DEEPSEEK_PRESET}
        existingProvider={makeProvider()}
        onBack={vi.fn()}
        onAdvanced={vi.fn()}
        onConnected={vi.fn()}
      />,
      { wrapper },
    );

    const input = document.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: TYPED_KEY } });
    fireEvent.click(screen.getByTestId('provider-quick-connect-submit'));

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const [data] = saveMock.mock.calls[0] as [Record<string, unknown>];
    expect(data.api_key).toBe(TYPED_KEY);
  });
});

describe('ProviderPickerView — quick-connect routing', () => {
  beforeEach(() => {
    saveMock.mockClear();
    useConversationStore.setState({
      settingsTab: 'provider-picker',
      providerEditTarget: null,
    });
  });

  it('shows the quick panel for a simple preset', async () => {
    const { wrapper } = makeWrapper();
    render(<ProviderPickerView />, { wrapper });

    // anthropic-official declares fields: ['api_key'] — simple.
    const card = await screen.findByTestId(
      'provider-picker-option-anthropic-official',
    );
    fireEvent.click(card);

    expect(
      await screen.findByTestId('provider-quick-connect'),
    ).toBeDefined();
    expect(useConversationStore.getState().settingsTab).toBe(
      'provider-picker',
    );
  });

  it('routes presets with extra fields to the full edit page', async () => {
    const { wrapper } = makeWrapper();
    render(<ProviderPickerView />, { wrapper });

    // bedrock declares fields: ['extra_env'] — advanced.
    const card = await screen.findByTestId('provider-picker-option-bedrock');
    fireEvent.click(card);

    expect(screen.queryByTestId('provider-quick-connect')).toBeNull();
    const state = useConversationStore.getState();
    expect(state.settingsTab).toBe('provider-edit');
    expect(state.providerEditTarget).toEqual({ presetKey: 'bedrock' });
  });
});

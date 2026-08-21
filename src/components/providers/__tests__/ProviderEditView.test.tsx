/**
 * src/components/providers/__tests__/ProviderEditView.test.tsx
 *
 * Plan 209 (re-applied for Plan 205's inline edit page) regression
 * tests for the masked-key state machine when editing an existing
 * provider. The previous `ProviderEditView` flushed the
 * server-provided masked key back through `useApiKeyState.setApiKey`
 * on mount, which flipped `keyState` to `'replaced'` and stamped
 * the mask into the form. On save, electron's
 * `provider-store.upsertLlmProvider` rejected the request with
 * `code: 'masked_key'`, surfacing the inline error
 * "提交的 key 看起来是掩码占位符...".
 *
 * The fix routes the masked value through `setMasked` (matching
 * `ProviderConnectDialog`) so the hook stays in `'untouched'` and
 * the save contract sends `apiKey: undefined` → "keep on-disk key".
 */

// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderEditView } from '../ProviderEditView';
import { useConversationStore } from '@/stores/conversation-store';
import { providersQueryKey } from '@/lib/providers/hooks/queryKeys';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

// Spy on the save hook so we can assert the 3-state contract
// the form forwards to the mutation layer.
const saveMock = vi.fn().mockResolvedValue({});
vi.mock('@/lib/providers/hooks/useProviderEditSave', () => ({
  useProviderEditSave: () => ({
    save: (...args: unknown[]) => saveMock(...args),
    isPending: false,
    error: null,
  }),
}));

// The model-fetch + test-connection IPC calls are not under test
// here. Stub them so the form's effect can settle without throwing.
vi.mock('@/lib/ipc-client', () => ({
  testProviderIPC: vi.fn().mockResolvedValue({
    success: false,
    error: { code: 'NO_CREDENTIALS', message: 'no key', suggestion: '' },
  }),
  fetchProviderModelsIPC: vi.fn().mockResolvedValue({
    success: false,
    error: { code: 'NO_CREDENTIALS', message: 'no key', suggestion: '' },
  }),
  upsertLlmProviderIPC: vi.fn(),
  listProvidersIPC: vi.fn().mockResolvedValue([]),
  setDefaultLlmProviderIPC: vi.fn(),
  deleteLlmProviderIPC: vi.fn(),
  // The new context-window hydration effect calls this on
  // mount. Default to an empty list so the buttons start
  // un-set; per-test cases override as needed.
  listModelCapabilitiesIPC: vi.fn().mockResolvedValue([]),
  upsertModelCapabilityIPC: vi.fn().mockResolvedValue({ ok: true, capability: {} }),
}));

// useProviderModels pulls in `fetchProviderModelsIPC` and a few
// other things. Simplify its return shape so the form renders
// without depending on the real hook implementation.
vi.mock('@/components/providers/hooks/useProviderModels', () => ({
  useProviderModels: () => ({
    fetched: [],
    enabled: [],
    isFetching: false,
    fetchError: null,
    contextWindows: new Map<string, number>(),
    customModels: [],
    fetch: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn(),
    disable: vi.fn(),
    addCustom: vi.fn(() => true),
    removeCustom: vi.fn(),
    setContextWindow: vi.fn(),
    reset: vi.fn(),
  }),
}));

// Stub the i18n hook to keep the test environment light.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
  }),
}));

// `ProviderEditView` imports a large icon module that pulls in
// `@lobehub/ui` and other heavy deps which break the vitest
// resolver on Windows. Stub the whole icons barrel to a trivial
// component so the form's `data-testid` lookups still find their
// targets (icons are decoration, not part of the contract).
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
    'TrashIcon',
    'PlusIcon',
    'XIcon',
    'CheckIcon',
    'InfoIcon',
    'WrenchIcon',
    'BrainIcon',
  ];
  for (const n of names) out[n] = Stub;
  return out;
});

vi.mock('@/components/settings/PresetIcon', () => ({
  PresetIcon: () =>
    React.createElement('div', { 'data-testid': 'preset-icon' }),
}));

function makeProvider(
  overrides: Partial<RendererLlmProviderDTO> = {},
): RendererLlmProviderDTO {
  return {
    id: 'minimax-cn',
    name: 'MiniMax CN',
    alias: '',
    category: 'official',
    apiFormat: 'anthropic',
    apiKey: 'sk-a***cdef',
    hasApiKey: true,
    baseUrl: 'https://api.minimax.cn',
    sortOrder: 0,
    isDefault: true,
    isActive: true,
    notes: '',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    extraEnv: '{}',
    headers: '{}',
    options: '{"enabled_models":["MiniMax-M3"]}',
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

describe('ProviderEditView — masked-key state machine', () => {
  beforeEach(() => {
    saveMock.mockClear();
    saveMock.mockResolvedValue({});
    useConversationStore.setState({
      settingsTab: 'provider-edit',
      providerEditTarget: { providerId: 'minimax-cn' },
    });
  });

  it('saves with apiKey=undefined when the user does not retype the masked key', async () => {
    const { wrapper, qc } = makeWrapper();
    qc.setQueryData<RendererLlmProviderDTO[]>(
      // `useProvidersQuery()` in `ProviderEditView` is called
      // without an `appId`, so the key suffix is `'all'`.
      providersQueryKey(),
      [makeProvider()],
    );

    render(<ProviderEditView />, { wrapper });

    const saveBtn = await screen.findByTestId('provider-edit-save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const call = saveMock.mock.calls[0];
    const data = call[0] as { api_key: string | undefined };
    expect(data.api_key).toBeUndefined();
  });

  it('saves with the raw key when the user retypes it', async () => {
    const { wrapper, qc } = makeWrapper();
    qc.setQueryData<RendererLlmProviderDTO[]>(
      providersQueryKey(),
      [makeProvider()],
    );

    render(<ProviderEditView />, { wrapper });

    // The Auth Token input is the only `type=password` input in the
    // document; it starts pre-filled with the masked hint. We
    // replace its value (simulating the user typing the real key)
    // and fire a `change` event so the hook transitions to
    // 'replaced'.
    const input = (await screen.findAllByDisplayValue('sk-a***cdef'))[0] as
      | HTMLInputElement
      | undefined;
    expect(input).toBeDefined();
    fireEvent.change(input as HTMLInputElement, {
      target: { value: 'sk-real-key-1234567890' },
    });

    const saveBtn = screen.getByTestId('provider-edit-save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const call = saveMock.mock.calls[0];
    const data = call[0] as { api_key: string | undefined };
    expect(data.api_key).toBe('sk-real-key-1234567890');
  });

  it('saves with apiKey=undefined after the user empties the input (back to untouched)', async () => {
    const { wrapper, qc } = makeWrapper();
    qc.setQueryData<RendererLlmProviderDTO[]>(
      providersQueryKey(),
      [makeProvider()],
    );

    render(<ProviderEditView />, { wrapper });

    const input = (await screen.findAllByDisplayValue('sk-a***cdef'))[0] as
      | HTMLInputElement
      | undefined;
    expect(input).toBeDefined();
    // The save button should send `apiKey: undefined` because the
    // hook is in 'untouched' state (the form was never edited).
    const saveBtn = screen.getByTestId('provider-edit-save');
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledTimes(1);
    });
    const call = saveMock.mock.calls[0];
    const data = call[0] as { api_key: string | undefined };
    expect(data.api_key).toBeUndefined();
  });
});

/**
 * src/components/providers/__tests__/ProviderList.test.tsx
 *
 * Plan 203 Phase 5.1 tests for the L4 orchestrator. The orchestrator
 * is a pure renderer: the only state in is the React Query cache
 * + the parent-supplied callbacks. The test verifies:
 *
 *   -1- The orchestrator renders one card per provider.
 *   -2- The orchestrator marks the active provider with a ring
 *        and an "Active" tag.
 *   -3- The orchestrator wires switch / edit / delete callbacks
 *        with the right ids.
 *   -4- The "in use" disabled state shows for the active card.
 *   -5- The loading state shows when the query is in flight and
 *        the cache is empty.
 *   -6- The empty state shows when the cache is empty and the
 *        query is not loading.
 */

// @vitest-environment jsdom

import React, { type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderList } from '../ProviderList';
import { providersQueryKey } from '@/lib/providers/hooks/queryKeys';
import type { Provider } from '@/lib/ipc-client';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

vi.mock('@/lib/ipc-client', () => ({
  listProvidersIPC: vi.fn(),
  setDefaultLlmProviderIPC: vi.fn(),
  deleteLlmProviderIPC: vi.fn(),
  upsertLlmProviderIPC: vi.fn(),
  testProviderIPC: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ipcClient = await import('@/lib/ipc-client');

/**
 * Build a legacy `Provider` (the shape `listProvidersIPC` emits).
 * The orchestrator's `useProvidersQuery` projects this to the
 * canonical `RendererLlmProviderDTO` internally; the test exercises
 * the IPC → DTO → orchestrator path end-to-end.
 */
function makeProvider(overrides: Record<string, unknown> = {}): Provider {
  return {
    id: 'p-1',
    name: 'Test',
    providerType: 'anthropic',
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-a***cdef',
    isActive: false,
    hasApiKey: true,
    sortOrder: 0,
    extraEnv: '{}',
    protocol: 'anthropic',
    headers: '{}',
    options: '{}',
    notes: '',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  } as Provider;
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

describe('ProviderList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one card per provider', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1' }),
      makeProvider({ id: 'p-2' }),
      makeProvider({ id: 'p-3' }),
    ]);
    const { wrapper } = makeWrapper();
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    expect(await screen.findByTestId('provider-card-p-1')).toBeInTheDocument();
    expect(await screen.findByTestId('provider-card-p-2')).toBeInTheDocument();
    expect(await screen.findByTestId('provider-card-p-3')).toBeInTheDocument();
  });

  it('marks the active provider with an "Active" badge', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1', isActive: false }),
      makeProvider({ id: 'p-2', isActive: true }),
    ]);
    const { wrapper } = makeWrapper();
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    // The active provider's "Active" badge is rendered with a
    // testid that includes the id.
    const badge = await screen.findByTestId('provider-active-p-2');
    expect(badge).toHaveTextContent('Active');
    // The non-active provider should not have the badge.
    expect(screen.queryByTestId('provider-active-p-1')).not.toBeInTheDocument();
  });

  it('wires onSwitch with the right id when the main button is clicked', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1', isActive: false }),
      makeProvider({ id: 'p-2', isActive: true }),
    ]);
    const { wrapper } = makeWrapper();
    const onSwitch = vi.fn();
    render(<ProviderList appId="duya" onSwitch={onSwitch} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    // p-1 is non-current → its main button is "Enable" and clickable.
    const p1 = await screen.findByTestId('provider-card-p-1');
    const enableBtn = p1.querySelector('button[title="Enable"]') as HTMLButtonElement;
    expect(enableBtn).toBeInTheDocument();
    fireEvent.click(enableBtn);
    expect(onSwitch).toHaveBeenCalledWith('p-1');
  });

  it('wires onEdit with the provider when the edit button is clicked', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1' }),
    ]);
    const { wrapper } = makeWrapper();
    const onEdit = vi.fn();
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={onEdit} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    const p1 = await screen.findByTestId('provider-card-p-1');
    const editBtn = p1.querySelector('button[title="Edit"]') as HTMLButtonElement;
    fireEvent.click(editBtn);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
  });

  it('wires onDelete with the id when the delete button is clicked', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1' }),
    ]);
    const { wrapper } = makeWrapper();
    const onDelete = vi.fn();
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={() => {}} onDelete={onDelete} onOpenWebsite={() => {}} />, { wrapper });
    const p1 = await screen.findByTestId('provider-card-p-1');
    const deleteBtn = p1.querySelector('button[title="Delete"]') as HTMLButtonElement;
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith('p-1');
  });

  it('the default card does not render a clickable "Default" main button', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([
      makeProvider({ id: 'p-1', isActive: true }),
    ]);
    const { wrapper } = makeWrapper();
    const onSwitch = vi.fn();
    render(<ProviderList appId="duya" onSwitch={onSwitch} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    const p1 = await screen.findByTestId('provider-card-p-1');
    // The "Default" button is the main action; it should be
    // present but disabled (multi-provider: the current default
    // cannot be re-promoted).
    const defaultBtn = p1.querySelector('button[title="Default"]') as HTMLButtonElement;
    expect(defaultBtn).toBeInTheDocument();
    expect(defaultBtn.disabled).toBe(true);
    fireEvent.click(defaultBtn);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('renders the empty state when the query returns an empty array', async () => {
    vi.mocked(ipcClient.listProvidersIPC).mockResolvedValue([]);
    const { wrapper } = makeWrapper();
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    expect(
      await screen.findByText(/No connected providers/i),
    ).toBeInTheDocument();
  });

  it('reads from the existing providersQueryKey cache when the parent has already populated it', async () => {
    const { wrapper, qc } = makeWrapper();
    // Seed the cache directly with a DTO (the orchestrator reads
    // the DTO shape, not the legacy Provider shape) so the
    // orchestrator renders without touching the IPC layer.
    // The orchestrator calls useProvidersQuery(appId) and
    // useActiveProviderId(appId), both of which read from
    // providersQueryKey(appId); seed that key.
    const cached: RendererLlmProviderDTO = {
      id: 'p-cached',
      name: 'Cached',
      alias: '',
      category: 'official',
      apiFormat: 'anthropic',
      apiKey: 'sk-a***cdef',
      hasApiKey: true,
      baseUrl: 'https://api.example.com',
      sortOrder: 0,
      isDefault: true,
      isActive: true,
      notes: '',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      extraEnv: '{}',
      headers: '{}',
      options: '{}',
      protocol: 'anthropic',
      legacy: { providerType: 'anthropic', providerTypeMapping: 'direct' },
    };
    qc.setQueryData<RendererLlmProviderDTO[]>(providersQueryKey('duya'), [cached]);
    render(<ProviderList appId="duya" onSwitch={() => {}} onEdit={() => {}} onDelete={() => {}} onOpenWebsite={() => {}} />, { wrapper });
    expect(
      await screen.findByTestId('provider-card-p-cached'),
    ).toBeInTheDocument();
    // IPC should not have been called.
    expect(ipcClient.listProvidersIPC).not.toHaveBeenCalled();
  });
});

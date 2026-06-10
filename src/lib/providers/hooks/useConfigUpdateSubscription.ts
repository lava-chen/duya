/**
 * src/lib/providers/hooks/useConfigUpdateSubscription.ts
 *
 * Bridges the Electron `config:update` broadcast into the React
 * Query cache.
 *
 * Plan 203 Phase 1.3.
 *
 * When the Electron `ProviderStore` writes a new config (e.g. via
 * the IPC handler or a tray menu interaction), it broadcasts a
 * `config:update` event on the `configPort` MessagePort / IPC
 * channel. This hook subscribes to that broadcast and invalidates
 * the React Query caches that depend on the providers config.
 *
 * Mount this hook ONCE near the top of the settings tree (e.g. in
 * `ProvidersSection` or a higher-level `Settings` component).
 *
 * The full `ElectronAPI` type is declared globally in
 * `src/global.d.ts`. We narrow the surface we need via a small
 * local interface so this file does not depend on the preload
 * module directly.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  providersQueryKey,
  modelCapabilitiesQueryKey,
  providerModelsQueryKey,
  providerHealthQueryKey,
} from './queryKeys';

interface ConfigPortUpdateAPI {
  onConfigUpdate(handler: (config: unknown) => void): () => void;
}

interface ElectronAPIWithConfigPort {
  getConfigPort?(): ConfigPortUpdateAPI | null;
}

export function useConfigUpdateSubscription() {
  const qc = useQueryClient();
  useEffect(() => {
    const api = window.electronAPI as unknown as ElectronAPIWithConfigPort | undefined;
    const port = api?.getConfigPort?.();
    if (!port?.onConfigUpdate) return;
    const unsub = port.onConfigUpdate((_config) => {
      // Phase 1: invalidate the broad providers key. We can refine
      // to diff-based invalidation in a later plan once the IPC
      // payload carries a structured diff.
      qc.invalidateQueries({ queryKey: providersQueryKey() });
      qc.invalidateQueries({ queryKey: ['providers', 'capabilities'] });
      qc.invalidateQueries({ queryKey: modelCapabilitiesQueryKey('*') });
      qc.invalidateQueries({ queryKey: providerModelsQueryKey('*') });
      qc.invalidateQueries({ queryKey: providerHealthQueryKey('*') });
    });
    return unsub;
  }, [qc]);
}

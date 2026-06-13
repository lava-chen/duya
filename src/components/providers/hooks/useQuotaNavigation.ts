/**
 * src/components/providers/hooks/useQuotaNavigation.ts
 *
 * Plan 204 Phase 4.2: returns a callback that navigates the user
 * to the `usage` settings tab, where the existing
 * `ProviderQuotaView` lives (`SettingsView.tsx:33`).
 *
 * The hook is intentionally thin — it is a thin wrapper around
 * `useConversationStore.setSettingsTab('usage')` so callers don't
 * need to know the store shape. If a future plan adds a
 * deep-link that opens a quota modal in-place, this hook is the
 * one place to swap the implementation.
 *
 * The returned callback has a stable identity (memoized on the
 * store's `setSettingsTab` action, which Zustand guarantees
 * stable), so it can be passed as a prop without re-render churn.
 */

import { useCallback } from 'react';
import { useConversationStore } from '@/stores/conversation-store';

export function useQuotaNavigation(): () => void {
  const setTab = useConversationStore((s) => s.setSettingsTab);
  return useCallback(() => setTab('usage'), [setTab]);
}

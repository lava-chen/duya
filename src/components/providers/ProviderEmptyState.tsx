/**
 * src/components/providers/ProviderEmptyState.tsx
 *
 * Plan 204 Phase 2.2: cc-switch-style empty state for the
 * provider list. Centered card with a 64x64 icon, a heading,
 * a description, and a single "Add provider" button.
 *
 * This is a stripped-down version of cc-switch's
 * `ProviderEmptyState` (cc-switch also exposes an "Import from
 * Claude" button — duya does not have a deeplink importer in
 * scope, so we omit it).
 *
 * Pure presentation: takes a single `onAdd` callback. No IPC,
 * no React Query.
 */

import { PlusIcon, UsersThreeIcon } from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';

export interface ProviderEmptyStateProps {
  /** Open the add-provider flow. */
  onAdd: () => void;
}

export function ProviderEmptyState({ onAdd }: ProviderEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="provider-empty-state"
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-10 text-center"
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <UsersThreeIcon size={28} className="text-muted-foreground" />
      </div>
      <h3 className="text-base font-semibold text-foreground">
        {t('provider.noProviders')}
      </h3>
      <p className="mt-2 max-w-lg text-sm text-muted-foreground">
        {t('provider.noProvidersDescription')}
      </p>
      <button
        type="button"
        onClick={onAdd}
        data-testid="provider-empty-state-add"
        className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors"
      >
        <PlusIcon size={16} />
        {t('provider.addProvider')}
      </button>
    </div>
  );
}

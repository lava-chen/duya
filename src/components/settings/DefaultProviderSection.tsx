/**
 * src/components/settings/DefaultProviderSection.tsx
 *
 * Settings section that lets the user pick the soft default
 * provider — the implicit fallback for chat/vision/agent/etc.
 * when no explicit per-thread or per-task provider is set.
 *
 * Multiple providers can be configured and used in parallel;
 * this section only sets the *default* (one of them). It does
 * NOT lock the other providers.
 *
 * The default is shared across all subsystems (chat, vision,
 * gateway, agent process, etc.) and is what the "Default"
 * affordance on each provider card promotes to.
 */

import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { SpinnerGapIcon, CheckIcon } from '@/components/icons';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { useDefaultProviderId } from '@/components/providers/hooks/useDefaultProviderId';
import { useSetDefaultProviderMutation } from '@/lib/providers/hooks/useSetDefaultProviderMutation';
import type { AppId } from '@/lib/providers/hooks/queryKeys';

export interface DefaultProviderSectionProps {
  /** AppId binding. Reserved for Plan 205; today always 'duya'. */
  appId: AppId;
}

export function DefaultProviderSection({ appId }: DefaultProviderSectionProps) {
  const { t } = useTranslation();
  const { data: providers = [], isLoading } = useProvidersQuery(appId);
  const defaultId = useDefaultProviderId(appId);
  const setDefault = useSetDefaultProviderMutation(appId);
  // Track the optimistic value so the UI flips immediately, even
  // before the IPC roundtrip resolves. Cleared on settle.
  const [optimistic, setOptimistic] = useState<string | null | undefined>(undefined);
  const shownDefault = optimistic !== undefined ? optimistic : defaultId;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground">
        <SpinnerGapIcon size={16} className="animate-spin" />
        <span className="text-sm">{t('provider.loading')}</span>
      </div>
    );
  }

  const handleSetDefault = (id: string | null) => {
    setOptimistic(id);
    setDefault.mutate(id, {
      onSettled: () => setOptimistic(undefined),
      onError: () => setOptimistic(undefined),
    });
  };

  const configured = providers.filter((p) => p.hasApiKey);

  return (
    <section
      data-testid="default-provider-section"
      className="rounded-2xl border border-border/50 bg-surface/40 p-5"
    >
      <header className="mb-3">
        <h2 className="text-[15px] font-semibold text-foreground">
          {t('settings.defaultProvider.title')}
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          {t('settings.defaultProvider.description')}
        </p>
      </header>

      {configured.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          {t('settings.defaultProvider.noneConfigured')}
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="default-provider-list">
          {configured.map((p) => {
            const isDefault = shownDefault === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => handleSetDefault(isDefault ? null : p.id)}
                  disabled={setDefault.isPending}
                  data-testid={`default-provider-row-${p.id}`}
                  className={
                    'w-full flex items-center justify-between gap-3 rounded-lg border ' +
                    'px-3 py-2 text-left transition-colors ' +
                    (isDefault
                      ? 'border-accent/40 bg-accent/[0.06]'
                      : 'border-border/50 hover:border-border-active hover:bg-surface/60')
                  }
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {p.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {p.baseUrl || p.protocol}
                    </div>
                  </div>
                  {isDefault ? (
                    <span
                      data-testid={`default-provider-check-${p.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent"
                    >
                      <CheckIcon size={12} />
                      {t('settings.defaultProvider.current')}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {t('settings.defaultProvider.setAsDefault')}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {shownDefault === null && configured.length > 0 && (
        <p className="text-xs text-muted-foreground mt-3">
          {t('settings.defaultProvider.noDefaultHint')}
        </p>
      )}
    </section>
  );
}

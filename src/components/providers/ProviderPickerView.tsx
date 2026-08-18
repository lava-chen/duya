/**
 * src/components/providers/ProviderPickerView.tsx
 *
 * Plan 205 Phase B + Phase L3: the first step of the
 * "add a provider" flow. Renders as an inline page inside
 * the `providers` settings tab (no modal). Lists every
 * non-media `QUICK_PRESETS` as a 2-column card grid; each
 * card shows the preset icon, name, description, and a
 * "configured" badge if a provider with the same protocol +
 * baseUrl already exists.
 *
 * Quick-connect (this redesign): clicking a simple preset card
 * no longer navigates to the heavy `ProviderEditView`. The
 * picker swaps the grid for a lightweight `ProviderQuickConnect`
 * panel where the user only pastes the API key — models,
 * baseUrl, protocol, and env defaults come from the @duya/ai
 * catalog preset. Presets that need more than api_key/base_url
 * (bedrock, vertex, anthropic-thirdparty, … route straight to
 * the full edit page as before. The "configured" presets open
 * the quick panel in update mode (masked key, existing id).
 *
 * Phase L3 visual: cards match the duya settings card
 * style (`bg-surface/40` + `rounded-2xl` + `border-border/50`
 * + hover `border-accent/40`). Icon sits in a 40x40 tinted
 * background. Larger padding (p-5) for breathing room. The
 * 2-column grid stays because the user confirmed it earlier
 * (plan 204 decision D204.1).
 */

import { useState } from 'react';
import { ArrowLeftIcon, PlusIcon, CheckCircleIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { PresetIcon } from '@/components/settings/PresetIcon';
import { QUICK_PRESETS, type QuickPreset } from '@/lib/provider-presets';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import { ProviderQuickConnect } from './ProviderQuickConnect';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';

/** Fields the quick-connect panel knows how to collect. */
const QUICK_FIELDS = new Set(['name', 'api_key', 'base_url']);

/**
 * A preset is "simple" when every field it declares can be
 * filled by the quick panel (or defaulted from the preset).
 * Anything else (extra_env, model_mapping, model_names) needs
 * the full `ProviderEditView`.
 */
function isQuickConnectPreset(preset: QuickPreset): boolean {
  return preset.fields.every((f) => QUICK_FIELDS.has(f));
}

export function ProviderPickerView() {
  const { t } = useTranslation();
  const setSettingsTab = useConversationStore((s) => s.setSettingsTab);
  const enterProviderEdit = useConversationStore((s) => s.enterProviderEdit);
  const { data: providers = [] } = useProvidersQuery();
  const [selected, setSelected] = useState<QuickPreset | null>(null);

  // Match the same filter used by `ProviderAddButton`. Media
  // presets are not LLM options.
  const presets: QuickPreset[] = QUICK_PRESETS.filter(
    (p) => p.category !== 'media',
  );

  const findConfiguredProvider = (
    preset: QuickPreset,
  ): RendererLlmProviderDTO | undefined => {
    return providers.find(
      (p) =>
        p.protocol === preset.protocol &&
        (preset.baseUrl === '' || p.baseUrl.startsWith(preset.baseUrl)),
    );
  };

  const isPresetConfigured = (preset: QuickPreset): boolean => {
    return !!findConfiguredProvider(preset);
  };

  const handlePick = (preset: QuickPreset) => {
    if (isQuickConnectPreset(preset)) {
      setSelected(preset);
    } else {
      enterProviderEdit({ presetKey: preset.key });
    }
  };

  const handleBack = () => {
    if (selected) {
      setSelected(null);
    } else {
      setSettingsTab('providers');
    }
  };

  const handleAdvanced = () => {
    if (!selected) return;
    const existing = findConfiguredProvider(selected);
    if (existing) {
      enterProviderEdit({ providerId: existing.id });
    } else {
      enterProviderEdit({ presetKey: selected.key });
    }
  };

  if (selected) {
    return (
      <ProviderQuickConnect
        preset={selected}
        existingProvider={findConfiguredProvider(selected) ?? null}
        onBack={handleBack}
        onAdvanced={handleAdvanced}
        onConnected={() => setSettingsTab('providers')}
      />
    );
  }

  return (
    <div data-testid="provider-picker-view" className="space-y-5 max-w-3xl">
      {/* Header — matches the edit page's header for visual
          consistency. */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          data-testid="provider-picker-back"
          className="shrink-0"
        >
          <ArrowLeftIcon size={16} />
          <span className="hidden sm:inline">{t('common.back')}</span>
        </Button>
        <h1 className="text-lg font-semibold text-foreground">
          {t('provider.addProvider')}
        </h1>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('provider.pickerSubtitle')}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {presets.map((preset) => {
          const configured = isPresetConfigured(preset);
          return (
            <button
              key={preset.key}
              type="button"
              onClick={() => handlePick(preset)}
              data-testid={`provider-picker-option-${preset.key}`}
              className={
                'group flex items-center gap-4 p-5 rounded-2xl border text-left ' +
                'bg-surface/40 border-border/50 hover:border-accent/40 ' +
                'hover:bg-surface/60 hover:shadow-sm transition-all duration-200'
              }
            >
              <div className="shrink-0 w-10 h-10 rounded-lg bg-muted flex items-center justify-center group-hover:scale-105 transition-transform">
                <PresetIcon iconKey={preset.iconKey} size={24} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground truncate">
                    {preset.name}
                  </span>
                  {configured && (
                    <span
                      data-testid={`provider-picker-configured-${preset.key}`}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-green-500/15 text-green-700 dark:text-green-300"
                    >
                      <CheckCircleIcon size={10} fill="currentColor" />
                      {t('provider.configured')}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {preset.descriptionZh}
                </div>
              </div>
              <div className="shrink-0 w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <PlusIcon size={16} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { useState, useMemo } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  CheckIcon,
  ArrowUpRightIcon,
  ArrowLeftIcon,
} from "@/components/icons";
import { QUICK_PRESETS } from "@/lib/provider-presets";
import type { OnboardingState } from "../OnboardingFlow";
import type { QuickPreset } from "@/lib/provider-presets";
import { PresetIcon } from "@/components/settings/PresetIcon";
import { ProviderConnectDialog, type ProviderFormData } from "@/components/settings/ProviderConnectDialog";

interface ConfigStepProps {
  state: OnboardingState;
  onUpdateState: (updates: Partial<OnboardingState>) => void;
  error: string | null;
  isLoading: boolean;
  onConnect: () => void;
  onBack: () => void;
  onConfigured: (preset: QuickPreset, data: ProviderFormData) => Promise<void>;
}

type ProviderCategory = "popular" | "china" | "selfhosted";

function categorizePresets(presets: QuickPreset[]): Record<ProviderCategory, QuickPreset[]> {
  const result: Record<ProviderCategory, QuickPreset[]> = {
    popular: [],
    china: [],
    selfhosted: [],
  };

  const selfHostedKeys = ["ollama", "anthropic-thirdparty"];
  const popularKeys = ["anthropic-official", "openrouter"];

  for (const preset of presets) {
    if (selfHostedKeys.includes(preset.key)) {
      result.selfhosted.push(preset);
    } else if (popularKeys.includes(preset.key)) {
      result.popular.push(preset);
    } else {
      result.china.push(preset);
    }
  }

  return result;
}

function getPresetIcon(preset: QuickPreset) {
  return <PresetIcon iconKey={preset.iconKey} size={20} />;
}

function getBillingBadge(preset: QuickPreset, t: (key: import("@/i18n").TranslationKey) => string) {
  if (!preset.meta?.billingModel) return null;

  const badges: Record<string, { text: string; className: string }> = {
    free: { text: t("provider.free"), className: "bg-green-500/10 text-green-500" },
    pay_as_you_go: { text: t("provider.payAsYouGo"), className: "bg-blue-500/10 text-blue-500" },
    coding_plan: { text: t("provider.codingPlan"), className: "bg-purple-500/10 text-purple-500" },
    token_plan: { text: t("provider.tokenPlan"), className: "bg-orange-500/10 text-orange-500" },
    self_hosted: { text: t("provider.selfHosted"), className: "bg-gray-500/10 text-gray-500" },
  };

  const badge = badges[preset.meta.billingModel];
  if (!badge) return null;

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${badge.className}`}>
      {badge.text}
    </span>
  );
}

export function ConfigStep({ state, onUpdateState, error, isLoading, onConnect, onBack, onConfigured }: ConfigStepProps) {
  const { t, locale } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);

  const categories = useMemo(() => {
    const chatPresets = QUICK_PRESETS.filter((p) => p.category !== "media");
    return categorizePresets(chatPresets);
  }, []);

  const handleSelectPreset = (preset: QuickPreset) => {
    onUpdateState({
      selectedPreset: preset,
      apiKey: "",
      selectedModel: "",
      selectedModels: [],
    });
    setDialogOpen(true);
  };

  const handleDialogSave = async (data: ProviderFormData) => {
    if (!state.selectedPreset) return;
    await onConfigured(state.selectedPreset, data);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-1" style={{ color: "var(--text)" }}>
          {t("onboarding.configTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("onboarding.configDesc")}
        </p>
        <a
          href="https://www.duya.dev/blog/token-provider-guide"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline flex items-center gap-1 mt-2"
        >
          {t("onboarding.learnMore")}
          <ArrowUpRightIcon size={12} />
        </a>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-4" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: '300px' }}>
        {/* Provider selection */}
        <div className="space-y-3">
          {(Object.keys(categories) as ProviderCategory[]).map((category) => {
            const presets = categories[category];
            if (presets.length === 0) return null;

            return (
              <div key={category}>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  {t(category === 'china' ? 'configStep.chinaRegion' : category === 'selfhosted' ? 'configStep.selfHosted' : `configStep.${category}`)}
                </h3>
                <div className="grid grid-cols-1 gap-2">
                  {presets.map((preset) => (
                    <button
                      key={preset.key}
                      onClick={() => handleSelectPreset(preset)}
                      disabled={isLoading}
                      className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                        state.selectedPreset?.key === preset.key
                          ? "border-[var(--accent)] bg-[var(--accent)]/5 ring-1 ring-[var(--accent)]/20"
                          : "border-[var(--border)] bg-[var(--chip)]/50 hover:border-[var(--accent)]/30"
                      }`}
                    >
                      <div className="w-9 h-9 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] flex items-center justify-center shrink-0 text-[var(--accent)]">
                        {getPresetIcon(preset)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{preset.name}</span>
                          {getBillingBadge(preset, t)}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {locale === "zh" && preset.descriptionZh
                            ? preset.descriptionZh
                            : preset.description}
                        </div>
                      </div>
                      {state.selectedPreset?.key === preset.key && (
                        <div className="w-5 h-5 rounded-full bg-[var(--accent)] flex items-center justify-center shrink-0">
                          <CheckIcon size={12} className="text-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Provider Connect Dialog */}
        {state.selectedPreset && (
          <ProviderConnectDialog
            preset={state.selectedPreset}
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSave={handleDialogSave}
          />
        )}

        {/* Error message */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-4 border-t border-[var(--border)] mt-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-[var(--chip)] rounded-lg transition-all"
        >
          <ArrowLeftIcon size={16} />
          {t("common.back")}
        </button>

        {state.selectedPreset ? (
          <button
            onClick={() => setDialogOpen(true)}
            disabled={isLoading}
            className="flex items-center gap-2 px-6 py-2.5 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {t("onboarding.connecting")}
              </>
            ) : (
              t("onboarding.connect")
            )}
          </button>
        ) : (
          <span className="text-sm text-muted-foreground">{t("onboarding.configDesc")}</span>
        )}
      </div>
    </div>
  );
}

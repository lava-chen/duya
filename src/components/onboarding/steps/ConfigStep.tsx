"use client";

import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import {
  KeyIcon,
  CheckIcon,
  ArrowUpRightIcon,
  ShieldCheckIcon,
  WarningIcon,
  GlobeIcon,
  ServerIcon,
  ArrowLeftIcon,
  SpinnerGapIcon,
  CubeIcon,
} from "@/components/icons";
import { QUICK_PRESETS } from "@/lib/provider-presets";
import type { OnboardingState } from "../OnboardingFlow";
import type { QuickPreset } from "@/lib/provider-presets";
import { PresetIcon } from "@/components/settings/PresetIcon";
import { getOllamaModelsIPC, type OllamaModel } from "@/lib/ipc-client";

interface ConfigStepProps {
  state: OnboardingState;
  onUpdateState: (updates: Partial<OnboardingState>) => void;
  error: string | null;
  isLoading: boolean;
  onConnect: () => void;
  onBack: () => void;
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

export function ConfigStep({ state, onUpdateState, error, isLoading, onConnect, onBack }: ConfigStepProps) {
  const { t, locale } = useTranslation();
  const [showKey, setShowKey] = useState(false);

  // Ollama models fetching
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);

  const categories = useMemo(() => {
    const chatPresets = QUICK_PRESETS.filter((p) => p.category !== "media");
    return categorizePresets(chatPresets);
  }, []);

  // Check if current preset is Ollama
  const isOllama = state.selectedPreset?.key === 'ollama' || state.selectedPreset?.provider_type === 'ollama';

  const handleSelectPreset = (preset: QuickPreset) => {
    onUpdateState({
      selectedPreset: preset,
      apiKey: "",
      selectedModel: "",
      selectedModels: [],
    });
    // Reset Ollama states
    setOllamaModels([]);
    setFetchModelsError(null);
  };

  // Fetch Ollama models when Ollama is selected
  useEffect(() => {
    if (!isOllama) {
      setOllamaModels([]);
      setFetchModelsError(null);
      return;
    }

    const fetchModels = async () => {
      setFetchingModels(true);
      setFetchModelsError(null);

      try {
        const baseUrl = state.selectedPreset?.baseUrl || 'http://localhost:11434';
        const result = await getOllamaModelsIPC(baseUrl);
        if (result.success && result.models) {
          setOllamaModels(result.models);
          // Auto-select first model if none selected
          if (!state.selectedModel && result.models.length > 0) {
            onUpdateState({ selectedModel: result.models[0].id });
          }
        } else {
          setFetchModelsError(result.error || t("configStep.ollamaHint"));
        }
      } catch (err) {
        setFetchModelsError(err instanceof Error ? err.message : t("configStep.ollamaHint"));
      } finally {
        setFetchingModels(false);
      }
    };

    fetchModels();
  }, [isOllama, state.selectedPreset?.baseUrl]);

  // Refresh Ollama models
  const handleRefreshModels = async () => {
    if (!isOllama) return;

    setFetchingModels(true);
    setFetchModelsError(null);

    try {
      const baseUrl = state.selectedPreset?.baseUrl || 'http://localhost:11434';
      const result = await getOllamaModelsIPC(baseUrl);
      if (result.success && result.models) {
        setOllamaModels(result.models);
      } else {
        setFetchModelsError(result.error || t("configStep.ollamaHint"));
      }
    } catch (err) {
      setFetchModelsError(err instanceof Error ? err.message : t("configStep.ollamaHint"));
    } finally {
      setFetchingModels(false);
    }
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
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto pr-1 space-y-4" style={{ maxHeight: 'calc(100vh - 400px)', minHeight: '300px' }}>
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

        {/* Model selection for non-Ollama providers */}
        {state.selectedPreset && !isOllama && state.selectedPreset.defaultModels && state.selectedPreset.defaultModels.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <label className="text-sm font-medium flex items-center gap-2">
              <CubeIcon size={14} />
              {t("configStep.recommendedModels")}
            </label>
            <div className="grid grid-cols-1 gap-1 max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg p-1">
              {state.selectedPreset.defaultModels.map((model) => {
                const isSelected = state.selectedModels.includes(model.modelId);
                return (
                  <button
                    key={model.modelId}
                    type="button"
                    onClick={() => {
                      const next = isSelected
                        ? state.selectedModels.filter((m) => m !== model.modelId)
                        : [...state.selectedModels, model.modelId];
                      onUpdateState({
                        selectedModels: next,
                        selectedModel: next.length > 0 && !state.selectedModel ? next[0] : state.selectedModel,
                      });
                    }}
                    className={`flex items-center justify-between px-3 py-2 rounded text-left transition-colors ${
                      isSelected
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "hover:bg-[var(--chip)]"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? "border-[var(--accent)] bg-[var(--accent)]"
                          : "border-[var(--border)]"
                      }`}>
                        {isSelected && <CheckIcon size={10} className="text-white" />}
                      </div>
                      <span className="text-sm font-mono truncate">{model.displayName}</span>
                    </div>
                    {model.role && (
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{model.role}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("configStep.modelSelectionHint")}
            </p>
          </div>
        )}

        {/* Custom model input for non-Ollama providers without presets */}
        {state.selectedPreset && !isOllama && (!state.selectedPreset.defaultModels || state.selectedPreset.defaultModels.length === 0) && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <label className="text-sm font-medium flex items-center gap-2">
              <CubeIcon size={14} />
              {t("configStep.customModelLabel")}
            </label>
            <input
              type="text"
              value={state.selectedModel}
              onChange={(e) => onUpdateState({ selectedModel: e.target.value })}
              placeholder={t("configStep.customModelPlaceholder")}
              disabled={isLoading}
              className="w-full px-4 py-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-input)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50 transition-all"
            />
            <p className="text-xs text-muted-foreground">
              {t("configStep.customModelHint")}
            </p>
          </div>
        )}

        {/* Ollama Model Selection */}
        {isOllama && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium flex items-center gap-2">
                <ServerIcon size={14} />
                {t("configStep.selectModel")}
              </label>
              <button
                type="button"
                onClick={handleRefreshModels}
                disabled={fetchingModels}
                className="text-[11px] px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {fetchingModels ? (
                  <span className="flex items-center gap-1">
                    <SpinnerGapIcon size={10} className="animate-spin" />
                    {t("configStep.fetching")}
                  </span>
                ) : (
                  t("configStep.refresh")
                )}
              </button>
            </div>

            {fetchingModels && ollamaModels.length === 0 ? (
              <div className="flex items-center justify-center py-4 text-muted-foreground">
                <SpinnerGapIcon size={16} className="animate-spin mr-2" />
                {t("configStep.fetchingModels")}
              </div>
            ) : fetchModelsError ? (
              <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-destructive">
                  {t("configStep.fetchFailed")}{fetchModelsError}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("configStep.ollamaHint")}
                </p>
              </div>
            ) : ollamaModels.length > 0 ? (
              <div className="grid grid-cols-1 gap-1 max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg p-1">
                {ollamaModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onUpdateState({ selectedModel: model.id })}
                    className={`flex items-center justify-between px-3 py-2 rounded text-left transition-colors ${
                      state.selectedModel === model.id
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "hover:bg-[var(--chip)]"
                    }`}
                  >
                    <span className="text-sm font-mono">{model.name}</span>
                    {model.size && (
                      <span className="text-[10px] text-muted-foreground">
                        {(model.size / 1024 / 1024 / 1024).toFixed(1)} GB
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-[var(--chip)] border border-[var(--border)]">
                <p className="text-sm text-muted-foreground">
                  {t("configStep.noModelsFound")}
                </p>
                <code className="block mt-2 text-xs font-mono bg-[var(--bg-surface)] px-2 py-1 rounded">
                  ollama pull llama3.2
                </code>
              </div>
            )}
          </div>
        )}

        {/* API Key input - hide for Ollama */}
        {state.selectedPreset && !isOllama && (
          <div className="space-y-3 pt-2 border-t border-[var(--border)]">
            {state.selectedPreset.meta?.apiKeyUrl && (
              <a
                href={state.selectedPreset.meta.apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-[var(--accent)] hover:underline"
              >
                {t("onboarding.getApiKey")}
                <ArrowUpRightIcon size={14} />
              </a>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium flex items-center gap-2">
                <KeyIcon size={14} />
                {t("onboarding.apiKeyLabel")}
              </label>
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={state.apiKey}
                  onChange={(e) => onUpdateState({ apiKey: e.target.value })}
                  placeholder={t("onboarding.apiKeyPlaceholder")}
                  disabled={isLoading}
                  className="w-full px-4 py-2.5 pr-10 rounded-xl border border-[var(--border)] bg-[var(--bg-input)] text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showKey ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Privacy notice */}
            <div className="p-3 rounded-lg bg-[var(--accent)]/5 border border-[var(--accent)]/10">
              <p className="text-xs text-muted-foreground leading-relaxed" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
                {t("onboarding.privacyNotice")}
              </p>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <WarningIcon size={16} className="text-destructive shrink-0 mt-0.5" />
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

        <button
          onClick={onConnect}
          disabled={
            !state.selectedPreset ||
            isLoading ||
            (isOllama ? !state.selectedModel : !state.apiKey.trim())
          }
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
      </div>
    </div>
  );
}

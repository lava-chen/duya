"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { listProvidersIPC, upsertProviderIPC, activateProviderIPC } from "@/lib/ipc-client";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { WelcomeStep } from "./steps/WelcomeStep";
import { ConfigStep } from "./steps/ConfigStep";
import { CompleteStep } from "./steps/CompleteStep";
import type { QuickPreset } from "@/lib/provider-presets";
import type { ProviderFormData } from "@/components/settings/ProviderConnectDialog";
import type { Locale } from "@/i18n";
import { getLocaleFromAcceptLanguage } from "@/i18n";

export interface OnboardingState {
  locale: Locale;
  selectedPreset: QuickPreset | null;
  apiKey: string;
  selectedModel: string;
  selectedModels: string[];
}

interface OnboardingFlowProps {
  onComplete?: () => void;
  forceShow?: boolean;
}

const STEPS = [
  { key: "welcome", titleKey: "onboarding.stepWelcome" as const },
  { key: "config", titleKey: "onboarding.stepConfig" as const },
  { key: "complete", titleKey: "onboarding.stepComplete" as const },
];

// Fixed dialog size: never reflows when step content changes.
const DIALOG_SIZE = { width: 560, height: 560 };

export function OnboardingFlow({ onComplete, forceShow }: OnboardingFlowProps) {
  const { t, locale, setLocale } = useTranslation();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasProviders, setHasProviders] = useState<boolean | null>(null);

  const [state, setState] = useState<OnboardingState>({
    locale: locale,
    selectedPreset: null,
    apiKey: "",
    selectedModel: "",
    selectedModels: [],
  });

  useEffect(() => {
    listProvidersIPC()
      .then((providers) => {
        const hasConfigured = providers.some((p) => p.hasApiKey || p.apiKey);
        setHasProviders(hasConfigured);
      })
      .catch(() => setHasProviders(false));
  }, []);

  useEffect(() => {
    const detected = getLocaleFromAcceptLanguage(navigator.language);
    if (detected !== locale) {
      setLocale(detected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markComplete = useCallback(() => {
    localStorage.setItem("duya-onboarding-completed", "true");
    onComplete?.();
  }, [onComplete]);

  const updateState = useCallback((updates: Partial<OnboardingState>) => {
    setState((prev) => ({ ...prev, ...updates }));
    setError(null);
  }, []);

  const handleNext = () => {
    if (currentStepIndex < STEPS.length - 1) {
      setCurrentStepIndex((i) => i + 1);
    }
  };

  const handleBack = () => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((i) => i - 1);
    }
  };

  const handleSkip = () => {
    markComplete();
  };

  const handleConnect = async () => {
    const { selectedPreset, apiKey, selectedModel, selectedModels } = state;
    if (!selectedPreset) {
      setError(t("onboarding.errorNoApiKey"));
      return;
    }

    const isOllama = selectedPreset.key === 'ollama' || selectedPreset.provider_type === 'ollama';
    if (!isOllama && !apiKey.trim()) {
      setError(t("onboarding.errorNoApiKey"));
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Build enabled_models from user selections
      let enabledModels: string[] = [];
      let defaultModel = selectedModel;

      if (isOllama) {
        // Ollama: use the selected model as both default and enabled
        if (selectedModel) {
          enabledModels = [selectedModel];
        }
      } else if (selectedModels.length > 0) {
        // Non-Ollama: use user-selected models from the checkbox list
        enabledModels = selectedModels;
        if (!defaultModel && selectedModels.length > 0) {
          defaultModel = selectedModels[0];
        }
      } else if (selectedPreset.defaultModels && selectedPreset.defaultModels.length > 0) {
        // No user selection: include all preset default models as enabled
        enabledModels = selectedPreset.defaultModels.map((m) => m.modelId);
        if (!defaultModel && enabledModels.length > 0) {
          defaultModel = enabledModels[0];
        }
      }

      const options: Record<string, unknown> = {};
      if (defaultModel) {
        options.defaultModel = defaultModel;
      }
      if (enabledModels.length > 0) {
        options.enabled_models = enabledModels;
      }

      const provider = await upsertProviderIPC({
        id: selectedPreset.key || `preset-${Date.now()}`,
        name: selectedPreset.name,
        providerType: selectedPreset.provider_type,
        baseUrl: selectedPreset.baseUrl,
        apiKey: isOllama ? 'ollama' : apiKey.trim(),
        isActive: true,
        options: Object.keys(options).length > 0 ? options : undefined,
      });

      if (provider) {
        setCurrentStepIndex(2);
      } else {
        setError(t("onboarding.connectionFailed"));
      }
    } catch {
      setError(t("onboarding.connectionFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleProviderSaved = async (preset: QuickPreset, data: ProviderFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      const isOllama = preset.key === 'ollama' || preset.provider_type === 'ollama';
      let enabledModels: string[] = data.enabled_models ?? [];
      let defaultModel = "";

      // Parse role_models_json for default model
      if (data.role_models_json) {
        try {
          const roleModels = JSON.parse(data.role_models_json);
          if (roleModels.default) defaultModel = roleModels.default;
        } catch { /* ignore */ }
      }

      if (isOllama && defaultModel) {
        enabledModels = [defaultModel];
      } else if (enabledModels.length > 0 && !defaultModel) {
        defaultModel = enabledModels[0];
      } else if (preset.defaultModels && preset.defaultModels.length > 0) {
        enabledModels = preset.defaultModels.map((m) => m.modelId);
        if (!defaultModel) defaultModel = enabledModels[0];
      }

      const options: Record<string, unknown> = {};
      if (defaultModel) options.defaultModel = defaultModel;
      if (enabledModels.length > 0) options.enabled_models = enabledModels;

      const provider = await upsertProviderIPC({
        id: preset.key || `preset-${Date.now()}`,
        name: data.name || preset.name,
        providerType: data.provider_type || preset.provider_type,
        baseUrl: data.base_url || preset.baseUrl,
        apiKey: isOllama ? 'ollama' : data.api_key.trim(),
        isActive: true,
        options: Object.keys(options).length > 0 ? options : undefined,
        notes: data.notes,
      });

      if (provider) {
        await activateProviderIPC(provider.id);
        setCurrentStepIndex(2);
      } else {
        setError(t("onboarding.connectionFailed"));
      }
    } catch {
      setError(t("onboarding.connectionFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  if (!forceShow && hasProviders === true) {
    return null;
  }

  if (hasProviders === null) {
    return (
      <div className="fixed inset-0 bg-[var(--bg-canvas)] flex items-center justify-center z-50">
        <div className="animate-pulse flex flex-col items-center gap-3">
          <img src="/icon.png" alt="DUYA" className="w-12 h-12 rounded-xl" />
          <span className="text-sm text-muted-foreground">{t("onboarding.loading")}</span>
        </div>
      </div>
    );
  }

  const isLastStep = currentStepIndex === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Fixed-size dialog — size never changes with step content */}
      <div
        className="relative flex flex-col overflow-hidden rounded-xl bg-[var(--main-bg)] border border-border/50 shadow-2xl"
        style={{
          width: DIALOG_SIZE.width,
          height: DIALOG_SIZE.height,
          maxWidth: "calc(100vw - 2rem)",
          maxHeight: "calc(100vh - 2rem)",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 shrink-0">
          <div className="flex items-center gap-2.5">
            <img src="./icon.png" alt="DUYA" className="w-7 h-7 rounded-lg" />
            <span className="font-semibold text-base" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
              DUYA
            </span>
          </div>

          {/* Skip button - show on all steps except last */}
          {!isLastStep && (
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              <XIcon size={14} />
              {t("onboarding.skip")}
            </Button>
          )}
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-2 shrink-0">
          {STEPS.map((_, index) => (
            <div
              key={index}
              className={`h-2 rounded-full transition-all duration-300 ${
                index === currentStepIndex
                  ? "w-8 bg-[var(--accent)]"
                  : index < currentStepIndex
                  ? "w-2 bg-[var(--accent)]/60"
                  : "w-2 bg-[var(--border)]"
              }`}
            />
          ))}
        </div>

        {/* Step content — scrolls internally, dialog stays fixed */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {currentStepIndex === 0 && <WelcomeStep onStart={handleNext} locale={locale} onSetLocale={setLocale} />}
          {currentStepIndex === 1 && (
            <ConfigStep
              state={state}
              onUpdateState={updateState}
              error={error}
              isLoading={isLoading}
              onConnect={handleConnect}
              onBack={handleBack}
              onConfigured={handleProviderSaved}
            />
          )}
          {currentStepIndex === 2 && <CompleteStep onEnter={markComplete} />}
        </div>

        {/* Step indicator */}
        <div className="text-center py-3 border-t border-border/30 shrink-0">
          <span className="text-xs text-muted-foreground">
            {t("onboarding.stepOf", { current: currentStepIndex + 1, total: STEPS.length })}
          </span>
        </div>
      </div>
    </div>
  );
}

export default OnboardingFlow;

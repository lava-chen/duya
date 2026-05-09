"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { listProvidersIPC, upsertProviderIPC } from "@/lib/ipc-client";
import { XIcon } from "@/components/icons";
import { WelcomeStep } from "./steps/WelcomeStep";
import { FeatureCarousel } from "./steps/FeatureCarousel";
import { ConfigStep } from "./steps/ConfigStep";
import { CompleteStep } from "./steps/CompleteStep";
import type { QuickPreset } from "@/lib/provider-presets";
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
}

const STEPS = [
  { key: "welcome", titleKey: "onboarding.stepWelcome" as const },
  { key: "features", titleKey: "onboarding.stepFeatures" as const },
  { key: "config", titleKey: "onboarding.stepConfig" as const },
  { key: "complete", titleKey: "onboarding.stepComplete" as const },
];

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
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
        setCurrentStepIndex(3);
      } else {
        setError(t("onboarding.connectionFailed"));
      }
    } catch {
      setError(t("onboarding.connectionFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  if (hasProviders === true) {
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
  const isConfigStep = currentStepIndex === 2;

  return (
    <div className="fixed inset-0 bg-[var(--bg-canvas)] z-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <span className="font-semibold text-lg" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>DUYA</span>

          {/* Skip button - show on all steps except last */}
          {!isLastStep && (
            <button
              onClick={handleSkip}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
            >
              <XIcon size={14} />
              {t("onboarding.skip")}
            </button>
          )}
        </div>

        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 mb-8">
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

        {/* Main content card */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl shadow-xl overflow-hidden" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <div className="p-8 h-full flex flex-col">
            {currentStepIndex === 0 && <WelcomeStep onStart={handleNext} locale={locale} onSetLocale={setLocale} />}
            {currentStepIndex === 1 && <FeatureCarousel onComplete={handleNext} />}
            {currentStepIndex === 2 && (
              <ConfigStep
                state={state}
                onUpdateState={updateState}
                error={error}
                isLoading={isLoading}
                onConnect={handleConnect}
                onBack={handleBack}
              />
            )}
            {currentStepIndex === 3 && <CompleteStep onEnter={markComplete} />}
          </div>
        </div>

        {/* Step indicator text */}
        <div className="text-center mt-4">
          <span className="text-xs text-muted-foreground">
            {t("onboarding.stepOf", { current: currentStepIndex + 1, total: STEPS.length })}
          </span>
        </div>
      </div>
    </div>
  );
}

export default OnboardingFlow;

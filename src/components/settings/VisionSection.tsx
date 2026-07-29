"use client";

import { useState, useCallback, useEffect } from "react";
import {
  EyeIcon,
  CheckCircleIcon,
  XCircleIcon,
  SpinnerGapIcon,
  LightningIcon,
  GlobeIcon,
  KeyIcon,
  CpuIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { testProviderIPC } from "@/lib/ipc-client";
import { SettingsSection, SettingsCard, SettingsToggle } from "@/components/settings/ui";
import type { VisionLLMConfig } from "@/types";

// Helper for translation keys that may not be in the type yet
function tKey(key: string): import('@/i18n').TranslationKey {
  return key as import('@/i18n').TranslationKey;
}

const VISION_PRESETS = [
  { provider: "openai", model: "gpt-4o", baseURL: "https://api.openai.com/v1" },
  { provider: "openai", model: "gpt-4o-mini", baseURL: "https://api.openai.com/v1" },
  { provider: "anthropic", model: "claude-sonnet-4-20250514", baseURL: "https://api.anthropic.com" },
  { provider: "openrouter", model: "google/gemini-2.5-flash", baseURL: "https://openrouter.ai/api/v1" },
  { provider: "ollama", model: "llava", baseURL: "http://localhost:11434" },
];

export function VisionSection() {
  const { t } = useTranslation();
  const { settings, save, saving } = useSettings();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");

  // Load settings
  useEffect(() => {
    if (settings.visionLLMConfig) {
      setEnabled(settings.visionLLMEnabled);
      setProvider(settings.visionLLMConfig.provider);
      setModel(settings.visionLLMConfig.model);
      setBaseURL(settings.visionLLMConfig.baseURL);
      setApiKey(settings.visionLLMConfig.apiKey);
    }
  }, [settings.visionLLMConfig, settings.visionLLMEnabled]);

  const handleSave = useCallback(async () => {
    const config: VisionLLMConfig = {
      provider,
      model,
      baseURL,
      apiKey,
      enabled,
    };

    await save({
      visionLLMConfig: config,
      visionLLMEnabled: enabled,
    });
  }, [provider, model, baseURL, apiKey, enabled, save]);

  const handlePresetSelect = useCallback((preset: typeof VISION_PRESETS[0]) => {
    setProvider(preset.provider);
    setModel(preset.model);
    setBaseURL(preset.baseURL);
  }, []);

  const handleTestConnection = useCallback(async () => {
    setTestStatus("testing");
    try {
      if (!provider || !model) {
        setTestStatus("error");
        return;
      }
      const result = await testProviderIPC({
        provider_type: provider,
        base_url: baseURL || undefined,
        api_key: apiKey || undefined,
        model,
      });
      setTestStatus(result.success ? "success" : "error");
    } catch {
      setTestStatus("error");
    }
  }, [provider, model, baseURL, apiKey]);

  const hasChanges =
    enabled !== settings.visionLLMEnabled ||
    provider !== (settings.visionLLMConfig?.provider || "") ||
    model !== (settings.visionLLMConfig?.model || "") ||
    baseURL !== (settings.visionLLMConfig?.baseURL || "") ||
    apiKey !== (settings.visionLLMConfig?.apiKey || "");

  return (
    <div className="settings-section">
      <SettingsSection
        title={t(tKey('settings.vision')) || 'Vision Model'}
        description={
          t(tKey('settings.visionDesc')) ||
          'Configure a separate vision model for image understanding and multimodal tasks.'
        }
        icon={<EyeIcon size={20} />}
      >
        <SettingsCard>
          <SettingsToggle
            label={t(tKey('settings.visionEnabled')) || 'Enable Vision Model'}
            description={
              t(tKey('settings.visionEnabledDesc')) ||
              'Use a dedicated model for image analysis'
            }
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked)}
          />
        </SettingsCard>
      </SettingsSection>

      {enabled && (
        <>
          <SettingsSection
            title={t(tKey('settings.visionPresets')) || 'Quick Presets'}
            description="Select a preset provider configuration"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {VISION_PRESETS.map((preset) => (
                <Button
                  key={`${preset.provider}-${preset.model}`}
                  variant="ghost"
                  className={`h-auto rounded-xl border border-border/30 bg-white/[0.025] p-3 text-left transition-all duration-200 hover:scale-[1.02] hover:bg-muted/30 ${
                    provider === preset.provider && model === preset.model
                      ? 'ring-2 ring-accent'
                      : ''
                  }`}
                  onClick={() => handlePresetSelect(preset)}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <CpuIcon size={14} className="text-accent" />
                    <span className="text-xs font-medium capitalize text-foreground">
                      {preset.provider}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">{preset.model}</span>
                </Button>
              ))}
            </div>
          </SettingsSection>

          <SettingsSection
            title={t(tKey('settings.visionConfiguration')) || 'Configuration'}
            description="Configure the vision model endpoint"
          >
            <SettingsCard divided={false}>
              <div className="py-4 space-y-4">
                {/* Provider */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
                    <GlobeIcon size={12} className="inline mr-1" />
                    {t(tKey('settings.provider')) || 'Provider'}
                  </label>
                  <Input
                    type="text"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="anthropic, openai, openrouter, ollama..."
                  />
                </div>

                {/* Model */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
                    <CpuIcon size={12} className="inline mr-1" />
                    {t(tKey('settings.model')) || 'Model'}
                  </label>
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="claude-sonnet-4-20250514, gpt-4o, llava..."
                  />
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
                    <LightningIcon size={12} className="inline mr-1" />
                    {t(tKey('settings.baseURL')) || 'Base URL'}
                  </label>
                  <Input
                    type="text"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </div>

                {/* API Key */}
                <div>
                  <label className="block text-xs font-medium mb-1.5 text-foreground">
                    <KeyIcon size={12} className="inline mr-1" />
                    {t(tKey('settings.apiKey')) || 'API Key'}
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                  />
                </div>

                {/* Test & Save Buttons */}
                <div className="flex items-center gap-3 pt-2">
                  <Button
                    variant="secondary"
                    onClick={handleTestConnection}
                    disabled={testStatus === "testing"}
                  >
                    {testStatus === "testing" ? (
                      <SpinnerGapIcon size={14} className="animate-spin" />
                    ) : testStatus === "success" ? (
                      <CheckCircleIcon size={14} className="text-green-500" />
                    ) : testStatus === "error" ? (
                      <XCircleIcon size={14} className="text-destructive" />
                    ) : (
                      <LightningIcon size={14} />
                    )}
                    {testStatus === "testing"
                      ? (t(tKey('settings.testing')) || 'Testing...')
                      : testStatus === "success"
                      ? (t(tKey('settings.testSuccess')) || 'Connected')
                      : testStatus === "error"
                      ? (t(tKey('settings.testFailed')) || 'Failed')
                      : (t(tKey('settings.testConnection')) || 'Test Connection')}
                  </Button>

                  <Button
                    variant="primary"
                    onClick={handleSave}
                    disabled={!hasChanges || saving}
                  >
                    {saving ? (
                      <SpinnerGapIcon size={14} className="animate-spin" />
                    ) : (
                      <CheckCircleIcon size={14} />
                    )}
                    {saving ? (t(tKey('settings.saving')) || 'Saving...') : (t(tKey('settings.save')) || 'Save')}
                  </Button>
                </div>
              </div>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            title={t(tKey('settings.visionHowItWorks')) || 'How it works'}
            description="Details about the vision model integration"
          >
            <SettingsCard divided={false}>
              <div className="py-4">
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>
                    • {t(tKey('settings.visionInfo1')) || 'When you attach images to a message, they are sent to the vision model for analysis'}
                  </li>
                  <li>
                    • {t(tKey('settings.visionInfo2')) || 'The vision model extracts information from images and provides it to the main AI'}
                  </li>
                  <li>
                    • {t(tKey('settings.visionInfo3')) || 'If no vision model is configured, images are sent directly to the main model (if supported)'}
                  </li>
                  <li>
                    • {t(tKey('settings.visionInfo4')) || 'Supported formats: PNG, JPEG, GIF, WebP, SVG'}
                  </li>
                </ul>
              </div>
            </SettingsCard>
          </SettingsSection>
        </>
      )}
    </div>
  );
}

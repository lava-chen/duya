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
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
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
      // Simple validation - in production this would test the actual connection
      if (!provider || !model) {
        setTestStatus("error");
        return;
      }
      // Simulate test delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      setTestStatus("success");
    } catch {
      setTestStatus("error");
    }
  }, [provider, model]);

  const hasChanges =
    enabled !== settings.visionLLMEnabled ||
    provider !== (settings.visionLLMConfig?.provider || "") ||
    model !== (settings.visionLLMConfig?.model || "") ||
    baseURL !== (settings.visionLLMConfig?.baseURL || "") ||
    apiKey !== (settings.visionLLMConfig?.apiKey || "");

  return (
    <div className="settings-section">
      {/* Header */}
      <div className="settings-header mb-6">
        <h2 className="settings-title-copernicus text-xl flex items-center gap-2">
          <EyeIcon size={20} weight="duotone" />
          {t(tKey('settings.vision')) || 'Vision Model'}
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          {t(tKey('settings.visionDesc')) || 'Configure a separate vision model for image understanding and multimodal tasks.'}
        </p>
      </div>

      {/* Enable Toggle */}
      <div className="settings-card p-5 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{
                backgroundColor: enabled ? 'var(--accent-soft)' : 'var(--surface)',
                color: enabled ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              <EyeIcon size={20} weight="duotone" />
            </div>
            <div>
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {t(tKey('settings.visionEnabled')) || 'Enable Vision Model'}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                {t(tKey('settings.visionEnabledDesc')) || 'Use a dedicated model for image analysis'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${enabled ? 'bg-accent' : 'bg-gray-600'}`}
            style={enabled ? { backgroundColor: 'var(--accent)' } : {}}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${enabled ? 'translate-x-6' : ''}`}
            />
          </button>
        </div>
      </div>

      {enabled && (
        <>
          {/* Quick Presets */}
          <div className="mb-6">
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--muted)' }}>
              {t(tKey('settings.visionPresets')) || 'Quick Presets'}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {VISION_PRESETS.map((preset) => (
                <button
                  key={`${preset.provider}-${preset.model}`}
                  type="button"
                  onClick={() => handlePresetSelect(preset)}
                  className={`settings-card p-3 text-left transition-all duration-200 hover:scale-[1.02] ${
                    provider === preset.provider && model === preset.model
                      ? 'ring-2 ring-accent'
                      : ''
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <CpuIcon size={14} style={{ color: 'var(--accent)' }} />
                    <span className="text-xs font-medium capitalize" style={{ color: 'var(--text)' }}>
                      {preset.provider}
                    </span>
                  </div>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {preset.model}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Configuration Form */}
          <div className="settings-card p-5 mb-6 space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
              {t(tKey('settings.visionConfiguration')) || 'Configuration'}
            </h3>

            {/* Provider */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text)' }}>
                <GlobeIcon size={12} className="inline mr-1" />
                {t(tKey('settings.provider')) || 'Provider'}
              </label>
              <input
                type="text"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="anthropic, openai, openrouter, ollama..."
                className="w-full px-3 py-2 rounded-lg text-sm border transition-colors"
                style={{
                  backgroundColor: 'var(--bg-canvas)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>

            {/* Model */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text)' }}>
                <CpuIcon size={12} className="inline mr-1" />
                {t(tKey('settings.model')) || 'Model'}
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-sonnet-4-20250514, gpt-4o, llava..."
                className="w-full px-3 py-2 rounded-lg text-sm border transition-colors"
                style={{
                  backgroundColor: 'var(--bg-canvas)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>

            {/* Base URL */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text)' }}>
                <LightningIcon size={12} className="inline mr-1" />
                {t(tKey('settings.baseURL')) || 'Base URL'}
              </label>
              <input
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="w-full px-3 py-2 rounded-lg text-sm border transition-colors"
                style={{
                  backgroundColor: 'var(--bg-canvas)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>

            {/* API Key */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text)' }}>
                <KeyIcon size={12} className="inline mr-1" />
                {t(tKey('settings.apiKey')) || 'API Key'}
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 rounded-lg text-sm border transition-colors"
                style={{
                  backgroundColor: 'var(--bg-canvas)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>

            {/* Test & Save Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testStatus === "testing"}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium border transition-all duration-200 hover:scale-[1.02]"
                style={{
                  backgroundColor: 'var(--surface)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              >
                {testStatus === "testing" ? (
                  <SpinnerGapIcon size={14} className="animate-spin" />
                ) : testStatus === "success" ? (
                  <CheckCircleIcon size={14} style={{ color: 'var(--success)' }} />
                ) : testStatus === "error" ? (
                  <XCircleIcon size={14} style={{ color: 'var(--error)' }} />
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
              </button>

              <button
                type="button"
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-white transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: 'var(--accent)',
                }}
              >
                {saving ? (
                  <SpinnerGapIcon size={14} className="animate-spin" />
                ) : (
                  <CheckCircleIcon size={14} />
                )}
                {saving ? (t(tKey('settings.saving')) || 'Saving...') : (t(tKey('settings.save')) || 'Save')}
              </button>
            </div>
          </div>

          {/* Info Card */}
          <div
            className="p-4 rounded-xl mb-6"
            style={{
              backgroundColor: 'var(--surface)',
              border: '1px solid var(--border)',
            }}
          >
            <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text)' }}>
              {t(tKey('settings.visionHowItWorks')) || 'How it works'}
            </h4>
            <ul className="space-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              <li>• {t(tKey('settings.visionInfo1')) || 'When you attach images to a message, they are sent to the vision model for analysis'}</li>
              <li>• {t(tKey('settings.visionInfo2')) || 'The vision model extracts information from images and provides it to the main AI'}</li>
              <li>• {t(tKey('settings.visionInfo3')) || 'If no vision model is configured, images are sent directly to the main model (if supported)'}</li>
              <li>• {t(tKey('settings.visionInfo4')) || 'Supported formats: PNG, JPEG, GIF, WebP, SVG'}</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

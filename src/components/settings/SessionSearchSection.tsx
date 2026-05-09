// SessionSearchSection.tsx - Settings for Session Search LLM configuration

"use client";

import { useState, useCallback } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import { SpinnerGapIcon, KeyIcon, GlobeIcon, CpuIcon } from "@/components/icons";

export function SessionSearchSection() {
  const { t } = useTranslation();
  const { settings, loading, error, save } = useSettings();
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [enabled, setEnabled] = useState(settings?.summaryLLMEnabled ?? false);
  const [provider, setProvider] = useState<'anthropic' | 'openai' | 'ollama'>(
    settings?.summaryLLMConfig?.provider ?? 'anthropic'
  );
  const [apiKey, setApiKey] = useState(settings?.summaryLLMConfig?.apiKey ?? '');
  const [model, setModel] = useState(settings?.summaryLLMConfig?.model ?? 'claude-sonnet-4-20250514');
  const [baseURL, setBaseURL] = useState(settings?.summaryLLMConfig?.baseURL ?? '');

  // Sync with settings when they load
  useState(() => {
    if (settings) {
      setEnabled(settings.summaryLLMEnabled ?? false);
      setProvider(settings.summaryLLMConfig?.provider ?? 'anthropic');
      setApiKey(settings.summaryLLMConfig?.apiKey ?? '');
      setModel(settings.summaryLLMConfig?.model ?? 'claude-sonnet-4-20250514');
      setBaseURL(settings.summaryLLMConfig?.baseURL ?? '');
    }
  });

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const config = enabled
        ? {
            provider,
            apiKey,
            model,
            baseURL: baseURL || undefined,
          }
        : null;

      await save({
        summaryLLMEnabled: enabled,
        summaryLLMConfig: config,
      });
    } finally {
      setIsSaving(false);
    }
  }, [enabled, provider, apiKey, model, baseURL, save]);

  const handleTestConnection = useCallback(async () => {
    // Test would be done via API in a real implementation
    alert('Connection test would be performed here');
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }

  return (
    <div className="settings-section">
      {/* Header */}
      <div className="settings-header">
        <h2 className="settings-title-copernicus">Session Search</h2>
        <p className="settings-description">
          Configure an auxiliary LLM to summarize search results when using the session search tool
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="settings-error">
          <p>{error}</p>
        </div>
      )}

      {/* Enable Toggle */}
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-label-group">
            <label>Enable Session Search Summarization</label>
            <span className="settings-description">
              Use an auxiliary LLM to generate better summaries of past session search results.
              When disabled, template-based summaries will be used instead.
            </span>
          </div>
          <div className="settings-control">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span className="settings-toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      {/* Configuration Card */}
      {enabled && (
        <>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-label-group">
                <label>Provider</label>
                <span className="settings-description">
                  Select the LLM provider for summarization
                </span>
              </div>
              <div className="settings-control">
                <select
                  className="settings-select"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai')}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label-group">
                <label>API Key</label>
                <span className="settings-description">
                  API key for the summarization provider
                </span>
              </div>
              <div className="settings-control flex-1 max-w-xs">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="settings-input w-full"
                />
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label-group">
                <label>Model</label>
                <span className="settings-description">
                  Model to use for summarization
                </span>
              </div>
              <div className="settings-control flex-1 max-w-xs">
                <select
                  className="settings-select w-full"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {provider === 'anthropic' ? (
                    <>
                      <option value="claude-opus-4-20250514">Claude Opus 4</option>
                      <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
                      <option value="claude-haiku-4-20250514">Claude Haiku 4</option>
                    </>
                  ) : (
                    <>
                      <option value="gpt-4o">GPT-4o</option>
                      <option value="gpt-4o-mini">GPT-4o Mini</option>
                      <option value="gpt-4-turbo">GPT-4 Turbo</option>
                    </>
                  )}
                </select>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-label-group">
                <label>Base URL (optional)</label>
                <span className="settings-description">
                  Custom API endpoint URL (leave empty for default)
                </span>
              </div>
              <div className="settings-control flex-1 max-w-xs">
                <input
                  type="text"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder={
                    provider === 'anthropic'
                      ? 'https://api.anthropic.com'
                      : 'https://api.openai.com/v1'
                  }
                  className="settings-input w-full"
                />
              </div>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={handleTestConnection}
              className="btn btn-secondary"
              disabled={!apiKey || isSaving}
            >
              Test Connection
            </button>
            <button
              onClick={handleSave}
              className="btn btn-primary"
              disabled={isSaving}
            >
              {isSaving ? (
                <>
                  <SpinnerGapIcon size={16} className="animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Configuration'
              )}
            </button>
          </div>
        </>
      )}

      {/* Info Card */}
      <div className="settings-card mt-4">
        <div className="settings-row">
          <div className="settings-label-group">
            <label>About Session Search</label>
            <span className="settings-description">
              The session search tool allows the agent to recall relevant information from past
              conversations. When enabled, an auxiliary LLM generates human-readable summaries of
              matching sessions. When disabled, raw search snippets are shown instead.
            </span>
          </div>
        </div>
        <div className="text-sm text-muted-foreground space-y-2 mt-2">
          <p>
            <strong>Note:</strong> The summarization LLM is only used for generating search
            summaries. The main conversation still uses your configured chat provider.
          </p>
          <p>
            <strong>Privacy:</strong> Search queries and session content are sent to the
            summarization LLM. Make sure to use a provider you trust.
          </p>
        </div>
      </div>
    </div>
  );
}

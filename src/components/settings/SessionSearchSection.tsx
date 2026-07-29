// SessionSearchSection.tsx - Settings for Session Search LLM configuration

"use client";

import { useState, useCallback } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useTranslation } from "@/hooks/useTranslation";
import { SpinnerGapIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsSelectRow,
  SettingsCardFooter,
} from "@/components/settings/ui";

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
      {/* Error Banner */}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <SettingsSection
        title="Session Search"
        description="Configure an auxiliary LLM to summarize search results when using the session search tool"
      >
        <SettingsCard>
          <SettingsToggle
            label="Enable Session Search Summarization"
            description="Use an auxiliary LLM to generate better summaries of past session search results. When disabled, template-based summaries will be used instead."
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked)}
          />
        </SettingsCard>
      </SettingsSection>

      {enabled && (
        <SettingsSection title="Configuration" description="Configure the summarization LLM provider">
          <SettingsCard>
            <SettingsSelectRow
              label="Provider"
              description="Select the LLM provider for summarization"
              value={provider}
              onValueChange={(v) => setProvider(v as 'anthropic' | 'openai')}
              options={[
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'openai', label: 'OpenAI' },
              ]}
            />
            <SettingsRow
              label="API Key"
              description="API key for the summarization provider"
            >
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </SettingsRow>
            <SettingsSelectRow
              label="Model"
              description="Model to use for summarization"
              value={model}
              onValueChange={(v) => setModel(v)}
              options={
                provider === 'anthropic'
                  ? [
                      { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
                      { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
                      { value: 'claude-haiku-4-20250514', label: 'Claude Haiku 4' },
                    ]
                  : [
                      { value: 'gpt-4o', label: 'GPT-4o' },
                      { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
                      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
                    ]
              }
            />
            <SettingsRow
              label="Base URL (optional)"
              description="Custom API endpoint URL (leave empty for default)"
            >
              <Input
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder={
                  provider === 'anthropic'
                    ? 'https://api.anthropic.com'
                    : 'https://api.openai.com/v1'
                }
              />
            </SettingsRow>
          </SettingsCard>

          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="secondary"
              onClick={handleTestConnection}
              disabled={!apiKey || isSaving}
            >
              Test Connection
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
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
            </Button>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="About" description="Learn more about session search summarization">
        <SettingsCard divided={false}>
          <div className="py-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              The session search tool allows the agent to recall relevant information from past
              conversations. When enabled, an auxiliary LLM generates human-readable summaries of
              matching sessions. When disabled, raw search snippets are shown instead.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Note:</strong> The summarization LLM is only used for generating search
              summaries. The main conversation still uses your configured chat provider.
            </p>
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">Privacy:</strong> Search queries and session content are sent to the
              summarization LLM. Make sure to use a provider you trust.
            </p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

"use client";

import { useState, useCallback, useEffect } from "react";
import { CpuIcon, SpinnerGapIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import { VisionModelSelector } from "./VisionModelSelector";
import { useIPC } from "@/hooks/useIPC";
import type { Provider } from "@/lib/ipc-client";
import {
  SettingsSection,
  SettingsCard,
} from "@/components/settings/ui";

function tKey(key: string): import('@/i18n').TranslationKey {
  return key as import('@/i18n').TranslationKey;
}

interface ModelSelectorRowProps {
  label: string;
  description: string;
  selectedModel: string;
  onModelChange: (value: string) => void;
  providers: Provider[];
  loading?: boolean;
}

function ModelSelectorRow({
  label,
  description,
  selectedModel,
  onModelChange,
  providers,
  loading,
}: ModelSelectorRowProps) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <label className="block text-sm font-medium" style={{ color: 'var(--text)' }}>
          {label}
        </label>
        <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
          {description}
        </p>
      </div>
      <div className="w-64 shrink-0">
        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <SpinnerGapIcon size={14} className="animate-spin" style={{ color: 'var(--muted)' }} />
            <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading...</span>
          </div>
        ) : (
          <VisionModelSelector
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            providers={providers}
          />
        )}
      </div>
    </div>
  );
}

export function ModelSelectionSection() {
  const { t } = useTranslation();
  const { listProviders } = useIPC();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  const [visionModel, setVisionModel] = useState("");
  const [gatewayModel, setGatewayModel] = useState("");
  const [titleModel, setTitleModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");

  const [originalVisionModel, setOriginalVisionModel] = useState("");
  const [originalGatewayModel, setOriginalGatewayModel] = useState("");
  const [originalTitleModel, setOriginalTitleModel] = useState("");
  const [originalEmbeddingModel, setOriginalEmbeddingModel] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Load providers
  useEffect(() => {
    const loadProviders = async () => {
      try {
        setProvidersLoading(true);
        const list = await listProviders();
        setProviders(list.filter(p => p.isActive));
      } catch (err) {
        console.error('[ModelSelection] Failed to load providers:', err);
      } finally {
        setProvidersLoading(false);
      }
    };

    loadProviders();
  }, [listProviders]);

  // Load model configurations
  useEffect(() => {
    const loadConfig = async () => {
      try {
        setLoading(true);
        console.log('[ModelSelection] Loading model configurations...');

        // Load vision settings from ConfigManager
        const visionSettings = await window.electronAPI.vision.get() as { providerId?: string; model?: string; enabled?: boolean };
        console.log('[ModelSelection] Vision settings:', visionSettings);

        if (visionSettings?.model && visionSettings?.providerId) {
          const fullValue = `${visionSettings.providerId}:${visionSettings.model}`;
          setVisionModel(fullValue);
          setOriginalVisionModel(fullValue);
        }

        // Load other model settings from Settings DB
        const settings = await window.electronAPI.settingsDb.getJson<{
          gatewayModel?: string;
          titleGenerationModel?: string;
          embeddingModel?: string;
        }>('modelSelection', {});
        console.log('[ModelSelection] Settings:', settings);

        if (settings.gatewayModel) {
          setGatewayModel(settings.gatewayModel);
          setOriginalGatewayModel(settings.gatewayModel);
        }
        if (settings.titleGenerationModel) {
          setTitleModel(settings.titleGenerationModel);
          setOriginalTitleModel(settings.titleGenerationModel);
        }
        if (settings.embeddingModel) {
          setEmbeddingModel(settings.embeddingModel);
          setOriginalEmbeddingModel(settings.embeddingModel);
        }
      } catch (err) {
        console.error('[ModelSelection] Failed to load config:', err);
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, []);

  const parseModelValue = (value: string): { providerId: string; model: string } => {
    const parts = value.split(':');
    if (parts.length >= 2) {
      return { providerId: parts[0], model: parts.slice(1).join(':') };
    }
    return { providerId: '', model: value };
  };

  const handleSave = useCallback(async () => {
    try {
      setSaving(true);
      setSaveStatus(null);

      const visionParsed = parseModelValue(visionModel);

      // Save vision settings to ConfigManager
      if (visionModel) {
        await window.electronAPI.vision.set({
          providerId: visionParsed.providerId,
          model: visionParsed.model,
          enabled: true,
        } as Record<string, unknown>);
      }

      // Save other model settings to Settings DB
      await window.electronAPI.settingsDb.setJson('modelSelection', {
        gatewayModel: gatewayModel || undefined,
        titleGenerationModel: titleModel || undefined,
        embeddingModel: embeddingModel || undefined,
      });

      // Update original values
      setOriginalVisionModel(visionModel);
      setOriginalGatewayModel(gatewayModel);
      setOriginalTitleModel(titleModel);
      setOriginalEmbeddingModel(embeddingModel);

      setSaveStatus({ type: 'success', message: 'Settings saved successfully' });
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (err) {
      console.error('[ModelSelection] Save error:', err);
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  }, [visionModel, gatewayModel, titleModel, embeddingModel]);

  const hasChanges =
    visionModel !== originalVisionModel ||
    gatewayModel !== originalGatewayModel ||
    titleModel !== originalTitleModel ||
    embeddingModel !== originalEmbeddingModel;

  if (loading) {
    return (
      <div className="settings-section">
        <div className="flex items-center justify-center py-12">
          <SpinnerGapIcon size={24} className="animate-spin" style={{ color: 'var(--muted)' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      {/* Header */}
      <div className="settings-header mb-6">
        <h2 className="settings-title-copernicus text-xl flex items-center gap-2">
          <CpuIcon size={20} weight="duotone" />
          {t(tKey('settings.modelSelection')) || 'Model Selection'}
        </h2>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          {t(tKey('settings.modelSelectionDesc')) || 'Configure models for different tasks'}
        </p>
      </div>

      {/* Save Status */}
      {saveStatus && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${
          saveStatus.type === 'success'
            ? 'bg-green-500/10 text-green-500 border border-green-500/20'
            : 'bg-red-500/10 text-red-500 border border-red-500/20'
        }`}>
          {saveStatus.message}
        </div>
      )}

      {/* Model Selection Card */}
      <SettingsSection
        title={t(tKey('settings.models')) || 'Models'}
        description={t(tKey('settings.modelsDesc')) || 'Select models for different purposes'}
      >
        <SettingsCard>
          <div className="space-y-6">
            {/* Vision Model */}
            <ModelSelectorRow
              label={t(tKey('settings.visionModel')) || 'Vision Model'}
              description={t(tKey('settings.visionModelDesc')) || 'Model for image understanding and analysis'}
              selectedModel={visionModel}
              onModelChange={setVisionModel}
              providers={providers}
              loading={providersLoading}
            />

            {/* Gateway Model */}
            <ModelSelectorRow
              label={t(tKey('settings.gatewayModel')) || 'Gateway Model'}
              description={t(tKey('settings.gatewayModelDesc')) || 'Model for gateway/channel interactions'}
              selectedModel={gatewayModel}
              onModelChange={setGatewayModel}
              providers={providers}
              loading={providersLoading}
            />

            {/* Title Generation Model */}
            <ModelSelectorRow
              label={t(tKey('settings.titleModel')) || 'Title Generation Model'}
              description={t(tKey('settings.titleModelDesc')) || 'Model for generating conversation titles'}
              selectedModel={titleModel}
              onModelChange={setTitleModel}
              providers={providers}
              loading={providersLoading}
            />

            {/* Embedding Model */}
            <ModelSelectorRow
              label={t(tKey('settings.embeddingModel')) || 'Embedding Model'}
              description={t(tKey('settings.embeddingModelDesc')) || 'Model for text embeddings (reserved for future use)'}
              selectedModel={embeddingModel}
              onModelChange={setEmbeddingModel}
              providers={providers}
              loading={providersLoading}
            />
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-end mt-6 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
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
                <span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
              ) : null}
              {saving ? (t(tKey('settings.saving')) || 'Saving...') : (t(tKey('settings.save')) || 'Save')}
            </button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Info Card */}
      <div
        className="p-4 rounded-xl mt-6"
        style={{
          backgroundColor: 'var(--surface)',
          border: '1px solid var(--border)',
        }}
      >
        <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text)' }}>
          {t(tKey('settings.modelSelectionHowItWorks')) || 'How it works'}
        </h4>
        <ul className="space-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
          <li>• {t(tKey('settings.modelSelectionInfo1')) || 'Vision Model: Analyzes images and extracts descriptions'}</li>
          <li>• {t(tKey('settings.modelSelectionInfo2')) || 'Gateway Model: Handles external channel interactions'}</li>
          <li>• {t(tKey('settings.modelSelectionInfo3')) || 'Title Generation: Automatically generates conversation titles'}</li>
          <li>• {t(tKey('settings.modelSelectionInfo4')) || 'Embedding Model: Used for semantic search and retrieval (coming soon)'}</li>
        </ul>
      </div>
    </div>
  );
}

"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Select } from "antd";
import { useIPC } from "@/hooks/useIPC";
import type { Provider, ModelInfo as IPCModelInfo } from "@/lib/ipc-client";

interface VisionModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string, providerId?: string) => void;
  /** Optional pre-loaded providers to avoid re-fetching */
  providers?: Provider[];
}

/**
 * Flat model option with provider info embedded
 */
interface VisionModelOption {
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
}

export function VisionModelSelector({
  selectedModel,
  onModelChange,
  providers: externalProviders,
}: VisionModelSelectorProps) {
  const { listProviders } = useIPC();
  const [internalProviders, setInternalProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);

  const providers = externalProviders || internalProviders;

  // Load providers on mount if not provided externally.
  // With the multi-provider model, every configured provider is
  // a vision-model candidate. We do NOT filter on `isActive`.
  useEffect(() => {
    if (externalProviders) return;
    async function loadProviders() {
      setLoading(true);
      try {
        const list = await listProviders();
        setInternalProviders(list);
      } finally {
        setLoading(false);
      }
    }
    loadProviders();
  }, [listProviders, externalProviders]);

  // Get all vision-capable models from all providers
  const getVisionModels = useCallback((): VisionModelOption[] => {
    const visionModels: VisionModelOption[] = [];

    for (const provider of providers) {
      console.log('[VisionModelSelector] Provider:', provider.id, provider.name, 'options:', provider.options);
      try {
        const opts = JSON.parse(provider.options || "{}");
        const models = opts.models as Record<string, IPCModelInfo> | undefined;

        if (models) {
          // Use stored capabilities data
          for (const [modelId, modelInfo] of Object.entries(models)) {
            console.log('[VisionModelSelector] Model:', modelId, 'supportsVision:', modelInfo.capabilities?.supportsVision);
            if (modelInfo.capabilities?.supportsVision) {
              visionModels.push({
                modelId,
                displayName: modelInfo.displayName || modelId,
                providerId: provider.id,
                providerName: provider.name,
              });
            }
          }
        } else if (opts.enabled_models && Array.isArray(opts.enabled_models)) {
          // Fallback: no capabilities data, include all models with [Provider] prefix
          for (const modelId of opts.enabled_models) {
            const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
            visionModels.push({
              modelId: cleanId,
              displayName: cleanId,
              providerId: provider.id,
              providerName: provider.name,
            });
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    return visionModels;
  }, [providers]);

  const visionModels = getVisionModels();

  // Check if selected model is not in the available list
  const isSelectedModelAvailable = !selectedModel || visionModels.some(
    (m) => `${m.providerId}:${m.modelId}` === selectedModel
  );

  // Parse selected model for display when it's not in the list
  const getSelectedModelDisplay = (): { providerId: string; modelId: string } | null => {
    if (!selectedModel) return null;
    const parts = selectedModel.split(':');
    if (parts.length >= 2) {
      return { providerId: parts[0], modelId: parts.slice(1).join(':') };
    }
    return null;
  };

  const selectedModelDisplay = getSelectedModelDisplay();

  // Build options for Ant Design Select
  const selectOptions = useMemo(() => {
    const options = visionModels.map((model) => ({
      value: `${model.providerId}:${model.modelId}`,
      label: `${model.displayName} [${model.providerName}]`,
    }));

    // Show saved model even if not in available list (e.g., provider disabled or model removed)
    if (!isSelectedModelAvailable && selectedModelDisplay) {
      options.push({
        value: selectedModel,
        label: `${selectedModelDisplay.modelId} [${selectedModelDisplay.providerId}] (unavailable)`,
      });
    }

    return options;
  }, [visionModels, isSelectedModelAvailable, selectedModel, selectedModelDisplay]);

  return (
    <div>
      <Select
        value={selectedModel || undefined}
        onChange={(value) => onModelChange(value)}
        disabled={loading}
        placeholder={loading ? 'Loading...' : 'Select a vision model...'}
        className="w-full settings-select-antd"
        classNames={{ popup: { root: "settings-select-dropdown" } }}
        options={selectOptions}
      />
      {visionModels.length === 0 && !loading && providers.length === 0 && (
        <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
          No active providers found. Please add and activate a provider first.
        </p>
      )}
      {visionModels.length === 0 && !loading && providers.length > 0 && (
        <p className="text-xs mt-1.5" style={{ color: 'var(--muted)' }}>
          No vision-capable models detected. Make sure your provider has models with vision support enabled.
        </p>
      )}
      {!isSelectedModelAvailable && selectedModelDisplay && (
        <p className="text-xs mt-1.5" style={{ color: 'var(--warning, #f59e0b)' }}>
          This model is currently unavailable. The provider may be disabled or the model no longer supports vision.
        </p>
      )}
    </div>
  );
}

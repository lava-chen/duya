"use client";

/**
 * src/components/settings/ProvidersSection.tsx
 *
 * Plan 204 Phase 3: the providers section shrinks from a 1066 LoC
 * monolith to ~250 LoC. The responsibilities that used to live
 * here are migrated to:
 *   - `ProviderManagement` (Plan 203 L5) — list / add / edit /
 *     delete / test / quota buttons + ProviderConnectDialog
 *     wiring. Owns the `provider:*` mutation layer.
 *   - `useProvidersQuery` (Plan 203 L1) — read providers through
 *     the React Query cache. The legacy `useState<Provider[]>` +
 *     `fetchProviders()` pattern is gone.
 *
 * What stays here:
 *   - The `ModelSelectionCard` — picks a default model for each
 *     task (vision / gateway / title). It is a per-task
 *     model assignment UI, not a provider-listing concern, so it
 *     does not move to `ProviderManagement`.
 *   - The page-level error / success banners that were once used
 *     by the inline mutation logic (now subsumed by
 *     `ProviderManagement`).
 *
 * Plan 203 Phase 1.4: the section previously consumed the L1
 * React Query layer (`useProvidersQuery`) instead of inline
 * `useState<Provider[]>`. After Plan 204, the section is just a
 * layout shell around `ProviderManagement` + `ModelSelectionCard`.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { useProvidersQuery } from "@/lib/providers/hooks/useProvidersQuery";
import type { RendererLlmProviderDTO } from "@/lib/providers/ipc-types";
import {
  SettingsSection,
  SettingsCard,
  SettingsSelectRow,
} from "@/components/settings/ui";
import { ProviderManagement } from "./ProviderManagement";
import {
  updateProviderIPC,
  getMemoryLlmProviderIPC,
  setMemoryLlmProviderIPC,
} from "@/lib/ipc-client";

type Provider = RendererLlmProviderDTO;

export function ProvidersSection() {
  const { t } = useTranslation();
  const {
    data: providers = [],
  } = useProvidersQuery();

  const sorted = useMemo(
    () => [...providers].sort((a, b) => a.sortOrder - b.sortOrder),
    [providers],
  );

  return (
    <div className="settings-section space-y-6">
      <SettingsSection
        title={t("settings.providers.connectedProviders")}
        description={t("settings.providers.description")}
      >
        <ProviderManagement appId="duya" />
      </SettingsSection>

      <MemoryProviderCard providers={sorted} />

      <ModelSelectionCard providers={sorted} />
    </div>
  );
}

/**
 * Memory system provider selector. Lets the user pick a dedicated
 * provider for the background memory worker (Stage 1 extraction +
 * Phase 2 consolidator). When set to "use default", the worker
 * falls back to the soft default provider.
 *
 * Changes take effect after app restart — the memory worker is
 * started once at boot with a fixed LLM client.
 */
function MemoryProviderCard({ providers }: { providers: Provider[] }) {
  const { t } = useTranslation();
  const [memoryProviderId, setMemoryProviderId] = useState<string>("");

  // Load the current memory provider on mount + when providers change
  // (so the label resolves correctly after lazy-load).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await getMemoryLlmProviderIPC();
        if (!cancelled) {
          setMemoryProviderId(p?.id ?? "");
        }
      } catch {
        // IPC not available (e.g. web-only mode) — leave as ""
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleChange = (value: string) => {
    setMemoryProviderId(value);
    // Empty string = use default (null on the backend)
    void setMemoryLlmProviderIPC(value || null);
  };

  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: "", label: t("settings.providers.memoryProviderUseDefault") },
    ];
    for (const p of providers) {
      opts.push({ value: p.id, label: p.name });
    }
    return opts;
  }, [providers, t]);

  if (providers.length === 0) return null;

  return (
    <SettingsSection
      title={t("settings.providers.memoryProvider")}
      description={t("settings.providers.memoryProviderDesc")}
    >
      <SettingsCard>
        <SettingsSelectRow
          label={t("settings.providers.memoryProvider")}
          description={t("settings.providers.memoryProviderHint")}
          value={memoryProviderId}
          onValueChange={handleChange}
          options={options}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Compact model selection card for different tasks (vision, gateway, title).
 * Kept here because it's a per-task model assignment UI, not a
 * provider-listing concern. Plan 205 may move it into
 * ProviderManagement as a sub-card.
 */
function ModelSelectionCard({ providers }: { providers: Provider[] }) {
  const { t } = useTranslation();
  const { settings, save } = useSettings();

  // Get all models from all providers
  const allModels = useMemo(() => {
    const models: { value: string; label: string; providerId: string }[] = [];
    for (const provider of providers) {
      try {
        const opts = JSON.parse(provider.options || "{}");
        const modelList = opts.enabled_models || [];
        for (const modelId of modelList) {
          const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
          // Use providerId:modelId as value for easy parsing
          const modelValue = `${provider.id}:${cleanId}`;
          if (!models.some(m => m.value === modelValue)) {
            models.push({
              value: modelValue,
              label: `${cleanId} [${provider.name}]`,
              providerId: provider.id,
            });
          }
        }
      } catch {
        // ignore
      }
    }
    return models;
  }, [providers]);

  // Current selections from settings - use useEffect to sync with settings
  const [visionModel, setVisionModel] = useState("");
  const [gatewayModel, setGatewayModel] = useState("");
  const [titleModel, setTitleModel] = useState("");

  // Sync vision model from settings when settings or providers change
  useEffect(() => {
    const config = settings?.visionLLMConfig;
    if (config?.model) {
      const provider = providers.find(p => p.name.toLowerCase() === config.provider?.toLowerCase());
      const value = provider ? `${provider.id}:${config.model}` : "";
      setVisionModel(value);
    }
  }, [settings?.visionLLMConfig, providers]);

  // Sync gateway model from settings
  useEffect(() => {
    setGatewayModel(settings?.gatewayModel || "");
  }, [settings?.gatewayModel]);

  // Sync title model from settings
  useEffect(() => {
    setTitleModel(settings?.titleGenerationModel || "");
  }, [settings?.titleGenerationModel]);

  // Parse "providerId:model" format
  const parseModelValue = (value: string): { providerId: string; model: string } => {
    const parts = value.split(':');
    if (parts.length >= 2) {
      return { providerId: parts[0], model: parts.slice(1).join(':') };
    }
    return { providerId: '', model: value };
  };

  const handleVisionChange = (value: string) => {
    setVisionModel(value);
    const parsed = parseModelValue(value);
    if (value && parsed.providerId && parsed.model) {
      const provider = providers.find(p => p.id === parsed.providerId);
      if (provider) {
        save({
          visionLLMConfig: {
            provider: provider.name.toLowerCase(),
            model: parsed.model,
            baseURL: provider.baseUrl,
            apiKey: provider.apiKey,
            enabled: true,
          },
          visionLLMEnabled: true,
        });
      }
    }
  };

  const handleGatewayChange = (value: string) => {
    const trimmedValue = value.trim();
    setGatewayModel(trimmedValue);
    if (window.electronAPI?.settingsDb?.setJson) {
      window.electronAPI.settingsDb.setJson('gatewayModel', trimmedValue);
    } else {
      save({ gatewayModel: trimmedValue });
    }
  };

  const handleTitleChange = (value: string) => {
    const trimmedValue = value.trim();
    setTitleModel(trimmedValue);
    if (window.electronAPI?.settingsDb?.setJson) {
      window.electronAPI.settingsDb.setJson('titleGenerationModel', trimmedValue);
    } else {
      if (providers.length > 0) {
        try {
          const extra = JSON.parse(providers[0].extraEnv || "{}") || {};
          extra.titleGenerationModel = value;
          updateProviderIPC(providers[0].id, { extraEnv: JSON.stringify(extra) });
        } catch {
          // ignore
        }
      }
    }
  };

  if (allModels.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      title={t("settings.providers.modelSelection") || "Model Selection"}
      description={t("settings.providers.modelSelectionDesc") || "Select models for different tasks"}
    >
      <SettingsCard>
        <SettingsSelectRow
          label={t("settings.providers.visionModel") || "Vision Model"}
          description={t("settings.providers.visionModelDesc") || "For image analysis"}
          value={visionModel}
          onValueChange={handleVisionChange}
          options={allModels}
        />
        <SettingsSelectRow
          label={t("settings.providers.gatewayModel") || "Gateway Model"}
          description={t("settings.providers.gatewayModelDesc") || "For bridge/channel sessions"}
          value={gatewayModel}
          onValueChange={handleGatewayChange}
          options={allModels}
        />
        <SettingsSelectRow
          label={t("settings.providers.titleModel") || "Title Model"}
          description={t("settings.providers.titleModelDesc") || "For auto-generating titles"}
          value={titleModel}
          onValueChange={handleTitleChange}
          options={allModels}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

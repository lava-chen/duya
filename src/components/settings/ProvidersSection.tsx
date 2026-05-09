"use client";

import { useState, useCallback, useEffect } from "react";
import {
  CpuIcon,
  SpinnerGapIcon,
  PlusIcon,
  XIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  CheckIcon,
  LightningIcon,
  HardDrivesIcon,
  ChartLineIcon,
  TrashIcon,
  NotePencilIcon,
} from "@/components/icons";
import { QUICK_PRESETS, findPresetByBaseUrl } from "@/lib/provider-presets";
import type { QuickPreset } from "@/lib/provider-presets";
import { SimpleProviderDialog } from "./SimpleProviderDialog";
import { useTranslation } from "@/hooks/useTranslation";
import { PresetIcon } from "./PresetIcon";
import { useSettings } from "@/hooks/useSettings";
import type { Provider as IpccProvider } from "@/lib/ipc-client";
import {
  listProvidersIPC,
  upsertProviderIPC,
  updateProviderIPC,
  deleteProviderIPC,
} from "@/lib/ipc-client";
import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
} from "@/components/settings/ui";

type Provider = IpccProvider;

interface ModelInfo {
  id: string;
  displayName: string;
}

/**
 * Generate a meaningful provider ID from provider type and name
 * Examples:
 *   - providerType: 'ollama', name: 'Ollama' → 'ollama'
 *   - providerType: 'openai', name: 'OpenAI' → 'openai'
 *   - providerType: 'anthropic', name: 'MiniMax (CN)' → 'minimax-cn'
 *   - providerType: 'openai-compatible', name: 'Custom Provider' → 'custom-provider'
 */
function generateProviderId(providerType: string, name: string, existingIds: string[]): string {
  // Always derive from name to ensure unique and meaningful IDs
  // This avoids conflicts when multiple providers have the same type (e.g., anthropic)
  let baseId = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '');     // Remove leading/trailing hyphens

  // If derived ID is empty (shouldn't happen), fall back to providerType
  if (!baseId) {
    baseId = providerType.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // If baseId is already unique, use it
  if (!existingIds.includes(baseId)) {
    return baseId;
  }

  // Otherwise, add a short suffix (last 8 chars of UUID)
  const suffix = crypto.randomUUID().slice(-8);
  return `${baseId}-${suffix}`;
}

interface ProviderCardProps {
  provider: Provider;
  models: ModelInfo[];
  modelsLoading: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onSelectModel: (modelId: string) => void;
  selectedModelId: string;
  onEdit: () => void;
  onDelete: () => void;
}

function ProviderCard({
  provider,
  models,
  modelsLoading,
  isExpanded,
  onToggleExpand,
  onSelectModel,
  selectedModelId,
  onEdit,
  onDelete,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const hasActiveModel = selectedModelId && models.some((m) => m.id === selectedModelId);

  return (
    <div className="border border-border/50 rounded-xl overflow-hidden bg-surface/50 hover:border-border/80 transition-all duration-200">
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="shrink-0">
          {isExpanded ? (
            <CheckIcon size={14} className="text-muted-foreground rotate-180" />
          ) : (
            <CheckIcon size={14} className="text-muted-foreground" />
          )}
        </div>
        <div className="shrink-0">{getProviderIcon(provider.providerType, provider.baseUrl)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{provider.name}</span>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                provider.hasApiKey
                  ? "bg-green-500/10 text-green-500 border border-green-500/20"
                  : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
              }`}
            >
              {provider.hasApiKey ? t("settings.providers.configured") : t("settings.providers.noKey")}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {provider.baseUrl || "default"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {modelsLoading && <SpinnerGapIcon size={12} className="animate-spin text-muted-foreground" />}
          {models.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
              {models.length} models
            </span>
          )}
          {hasActiveModel && (
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-500 border border-green-500/20">
              <CheckIcon size={10} />
              Active
            </span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="border-t border-border/30 bg-muted/20">
          {modelsLoading ? (
            <div className="px-4 py-4 text-xs text-muted-foreground flex items-center gap-2">
              <SpinnerGapIcon size={12} className="animate-spin" />
              Loading models...
            </div>
          ) : models.length > 0 ? (
            <div className="py-2">
              <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Available Models
              </div>
              {models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => onSelectModel(model.id)}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-accent/5 transition-colors text-left"
                >
                  <span className="shrink-0 w-4 h-4 flex items-center justify-center">
                    {selectedModelId === model.id ? (
                      <CheckIcon size={14} className="text-accent" />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full border border-border/50" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs truncate">{model.displayName}</div>
                    <div className="text-[10px] text-muted-foreground truncate font-mono">{model.id}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-4 text-xs text-muted-foreground">No models available</div>
          )}

          <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-border/20">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 font-medium transition-colors"
            >
              <NotePencilIcon size={12} />
              Edit
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80 font-medium transition-colors"
            >
              <TrashIcon size={12} />
              {t("settings.providers.disconnect")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderModelSelector({
  providers,
  onEditProvider,
  onDeleteProvider,
}: {
  providers: Provider[];
  onEditProvider: (provider: Provider) => void;
  onDeleteProvider: (provider: Provider) => void;
}) {
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [modelsCache, setModelsCache] = useState<Record<string, ModelInfo[]>>({});
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({});

  const getProviderModels = useCallback((provider: Provider): ModelInfo[] => {
    try {
      const opts = JSON.parse(provider.options || "{}");
      if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
        return opts.enabled_models.map((id: string) => {
          const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
          return { id: cleanId, displayName: cleanId };
        });
      }
    } catch (err) {
      console.warn("[ProvidersSection] Failed to parse provider options:", err instanceof Error ? err.message : String(err));
    }
    return [];
  }, []);

  const fetchModels = useCallback(
    async (provider: Provider) => {
      if (modelsCache[provider.id]) return;

      setModelsLoading((prev) => ({ ...prev, [provider.id]: true }));

      const enabledModels = getProviderModels(provider);
      if (enabledModels.length > 0) {
        setModelsCache((prev) => ({ ...prev, [provider.id]: enabledModels }));
        setModelsLoading((prev) => ({ ...prev, [provider.id]: false }));
        return;
      }

      try {
        if (window.electronAPI?.net?.testProvider) {
          const result = await window.electronAPI.net.testProvider({
            provider_type: provider.providerType,
            base_url: provider.baseUrl,
            api_key: provider.apiKey,
            model: "",
          });
          if (result.success && result.message) {
            // Try to parse as JSON, fallback to empty list if not JSON
            try {
              const data = JSON.parse(result.message);
              const models: ModelInfo[] = (data.models || []).map(
                (m: { id: string; display_name?: string; name?: string }) => ({
                  id: m.id,
                  displayName: m.display_name || m.name || m.id,
                })
              );
              setModelsCache((prev) => ({ ...prev, [provider.id]: models }));
            } catch {
              // Response is not JSON (e.g., Chinese success message), ignore
              console.log(`[ProvidersSection] Provider ${provider.id} returned non-JSON message:`, result.message);
            }
          }
        }
      } catch (err) {
        console.warn(`[ProvidersSection] Failed to fetch models for provider ${provider.id}:`, err instanceof Error ? err.message : String(err));
      }

      setModelsLoading((prev) => ({ ...prev, [provider.id]: false }));
    },
    [getProviderModels, modelsCache]
  );

  const toggleExpand = useCallback(
    (providerId: string) => {
      setExpandedProviders((prev) => {
        const next = new Set(prev);
        if (next.has(providerId)) {
          next.delete(providerId);
        } else {
          next.add(providerId);
          const provider = providers.find((p) => p.id === providerId);
          if (provider) {
            fetchModels(provider);
          }
        }
        return next;
      });
    },
    [providers, fetchModels]
  );

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      await saveSettings({ lastSelectedModel: modelId });
    },
    [saveSettings]
  );

  if (providers.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <span className="text-sm text-muted-foreground">{t("settings.providers.noConnectedProviders")}</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          models={modelsCache[provider.id] || []}
          modelsLoading={!!modelsLoading[provider.id]}
          isExpanded={expandedProviders.has(provider.id)}
          onToggleExpand={() => toggleExpand(provider.id)}
          onSelectModel={handleSelectModel}
          selectedModelId={settings.lastSelectedModel}
          onEdit={() => onEditProvider(provider)}
          onDelete={() => onDeleteProvider(provider)}
        />
      ))}
    </div>
  );
}

function getProviderIcon(providerType: string, baseUrl: string | undefined) {
  const url = (baseUrl || "").toLowerCase();

  switch (providerType) {
    case "anthropic":
      return <PresetIcon iconKey="anthropic" size={20} />;
    case "openrouter":
      return <PresetIcon iconKey="openrouter" size={20} />;
    case "ollama":
    case "openai-compatible":
      if (url.includes("11434") || url.includes("ollama")) {
        return <PresetIcon iconKey="ollama" size={20} />;
      }
      return <PresetIcon iconKey="server" size={20} />;
    case "bedrock":
      return <PresetIcon iconKey="bedrock" size={20} />;
    case "vertex":
      return <PresetIcon iconKey="google" size={20} />;
  }

  if (url.includes("anthropic")) return <PresetIcon iconKey="anthropic" size={20} />;
  if (url.includes("openrouter")) return <PresetIcon iconKey="openrouter" size={20} />;
  if (url.includes("bigmodel.cn") || url.includes("z.ai")) return <PresetIcon iconKey="zhipu" size={20} />;
  if (url.includes("kimi.com")) return <PresetIcon iconKey="kimi" size={20} />;
  if (url.includes("moonshot")) return <PresetIcon iconKey="moonshot" size={20} />;
  if (url.includes("minimax")) return <PresetIcon iconKey="minimax" size={20} />;
  if (url.includes("volces.com") || url.includes("volcengine")) return <PresetIcon iconKey="volcengine" size={20} />;
  if (url.includes("bailian") || url.includes("dashscope")) return <PresetIcon iconKey="bailian" size={20} />;
  if (url.includes("bedrock") || url.includes("aws.amazon")) return <PresetIcon iconKey="bedrock" size={20} />;
  if (url.includes("vertex") || url.includes("google") || url.includes("gcp")) return <PresetIcon iconKey="google" size={20} />;
  if (url.includes("ollama") || url.includes("11434")) return <PresetIcon iconKey="ollama" size={20} />;

  return <PresetIcon iconKey="server" size={20} />;
}

interface DiagnosticResult {
  providerId: string;
  providerName: string;
  status: "success" | "error" | "testing";
  message: string;
  latency?: number;
}

export function ProvidersSection() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [diagnosticResults, setDiagnosticResults] = useState<DiagnosticResult[]>([]);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<QuickPreset | null>(null);
  const [editProvider, setEditProvider] = useState<{
    id: string;
    name: string;
    provider_type: string;
    base_url: string;
    api_key: string;
    options?: unknown;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setError(null);
      const list = await listProvidersIPC();
      setProviders(list);
    } catch {
      setError(t("error.description"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleOpenPresetDialog = (preset: QuickPreset) => {
    setSelectedPreset(preset);
    setEditProvider(null);
    setDialogOpen(true);
  };

  const handleEditProvider = (provider: Provider) => {
    const preset =
      findPresetByBaseUrl(provider.baseUrl) ||
      QUICK_PRESETS.find((p) => p.provider_type === provider.providerType) ||
      QUICK_PRESETS[0];
    setSelectedPreset(preset);
    setEditProvider({
      id: provider.id,
      name: provider.name,
      provider_type: provider.providerType,
      base_url: provider.baseUrl,
      api_key: provider.apiKey,
      options: provider.options,
    });
    setDialogOpen(true);
  };

  const handleSimpleSave = async (data: {
    name: string;
    provider_type: string;
    base_url: string;
    api_key: string;
    enabled_models: string[];
    auth_style?: string;
  }) => {
    console.log("[ProvidersSection] handleSimpleSave called", {
      isEdit: !!editProvider,
      enabled_models: data.enabled_models,
      auth_style: data.auth_style,
    });

    const options: Record<string, unknown> = {};
    if (data.enabled_models && data.enabled_models.length > 0) {
      options.enabled_models = data.enabled_models;
    }
    if (data.auth_style) {
      options.auth_style = data.auth_style;
    }
    console.log("[ProvidersSection] Final options object:", options);

    if (editProvider) {
      console.log("[ProvidersSection] Updating existing provider:", editProvider.id);
      const updateData: Record<string, unknown> = {
        name: data.name,
        providerType: data.provider_type,
        baseUrl: data.base_url,
        headers: {},
        notes: "",
      };
      if (!data.api_key.startsWith("***")) {
        updateData.apiKey = data.api_key;
      }
      if (Object.keys(options).length > 0) {
        updateData.options = options;
      }
      console.log("[ProvidersSection] Update data:", updateData);

      const updated = await updateProviderIPC(editProvider.id, updateData);
      console.log("[ProvidersSection] Update result:", updated);

      if (updated) {
        setSuccess("Provider updated");
        setEditProvider(null);
        fetchProviders();
      } else {
        throw new Error(t("error.description"));
      }
    } else {
      console.log("[ProvidersSection] Creating new provider");
      console.log("[ProvidersSection] New provider options:", options);

      // Generate a meaningful provider ID
      const existingIds = providers.map(p => p.id);
      const providerId = generateProviderId(data.provider_type, data.name, existingIds);
      console.log("[ProvidersSection] Generated provider ID:", providerId);

      const created = await upsertProviderIPC({
        id: providerId,
        name: data.name,
        providerType: data.provider_type,
        baseUrl: data.base_url,
        apiKey: data.api_key,
        isActive: true,
        options: Object.keys(options).length > 0 ? options : undefined,
      });

      console.log("[ProvidersSection] Create result:", created);

      if (created) {
        setSuccess(t("settings.providers.connect"));
        fetchProviders();
      } else {
        throw new Error(t("error.description"));
      }
    }
  };

  const handleDelete = (provider: Provider) => {
    setDeleteTarget(provider);
  };

  const runDiagnostics = async () => {
    if (providers.length === 0) return;

    setIsRunningDiagnostics(true);
    setShowDiagnostics(true);
    setDiagnosticResults([]);

    for (const provider of providers) {
      setDiagnosticResults((prev) => [
        ...prev,
        {
          providerId: provider.id,
          providerName: provider.name,
          status: "testing",
          message: "Testing connection...",
        },
      ]);

      const startTime = Date.now();

      // Parse options to get auth_style
      let authStyle: string | undefined;
      try {
        const opts = JSON.parse(provider.options || "{}");
        authStyle = opts.auth_style;
      } catch {
        // Ignore parse errors
      }

      try {
        if (window.electronAPI?.net?.testProvider) {
          const result = await window.electronAPI.net.testProvider({
            provider_type: provider.providerType,
            base_url: provider.baseUrl,
            api_key: provider.apiKey,
            model: "",
            auth_style: authStyle,
          });

          const latency = Date.now() - startTime;

          if (result.success) {
            setDiagnosticResults((prev) =>
              prev.map((r) =>
                r.providerId === provider.id
                  ? { ...r, status: "success", message: "Connection successful", latency }
                  : r
              )
            );
          } else {
            const errorMessage = typeof result.error === "string" ? result.error : "Connection failed";
            setDiagnosticResults((prev) =>
              prev.map((r) =>
                r.providerId === provider.id ? { ...r, status: "error", message: errorMessage, latency } : r
              )
            );
          }
        } else {
          setDiagnosticResults((prev) =>
            prev.map((r) =>
              r.providerId === provider.id ? { ...r, status: "error", message: "Test not available" } : r
            )
          );
        }
      } catch (err) {
        const latency = Date.now() - startTime;
        setDiagnosticResults((prev) =>
          prev.map((r) =>
            r.providerId === provider.id
              ? { ...r, status: "error", message: err instanceof Error ? err.message : "Test failed", latency }
              : r
          )
        );
      }
    }

    setIsRunningDiagnostics(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;

    try {
      const deleted = await deleteProviderIPC(deleteTarget.id);
      if (deleted) {
        setSuccess(t("settings.providers.disconnect"));
        fetchProviders();
      } else {
        setError(t("error.description"));
      }
    } catch {
      setError(t("error.description"));
    } finally {
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">{t("settings.providers.loading")}</span>
      </div>
    );
  }

  const sorted = [...providers].sort((a, b) => a.sortOrder - b.sortOrder);
  const chatPresets = QUICK_PRESETS.filter((p) => p.category !== "media");

  return (
    <div className="settings-section">
      {/* Error / Success Banners */}
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-4 rounded-lg border border-green-500/50 bg-green-500/10 p-3">
          <p className="text-sm text-green-500">{success}</p>
        </div>
      )}

      {/* Connection Diagnostics */}
      <SettingsSection
        title={t("settings.providers.connectionDiagnostics")}
        description={t("settings.providers.connectionDiagnosticsDesc")}
        action={
          <button
            onClick={runDiagnostics}
            disabled={isRunningDiagnostics || providers.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {isRunningDiagnostics ? <SpinnerGapIcon size={16} className="animate-spin" /> : <LightningIcon size={16} />}
            {isRunningDiagnostics ? "Running..." : t("settings.providers.runDiagnostics")}
          </button>
        }
      >
        <SettingsCard>
          {showDiagnostics && diagnosticResults.length > 0 && (
            <div className="px-4 py-3.5 space-y-2">
              {diagnosticResults.map((result) => (
                <div
                  key={result.providerId}
                  className={`flex items-center justify-between px-4 py-3 rounded-lg text-sm ${
                    result.status === "success"
                      ? "bg-green-500/5 border border-green-500/20"
                      : result.status === "error"
                      ? "bg-red-500/5 border border-red-500/20"
                      : "bg-muted/30 border border-border/30"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {result.status === "testing" ? (
                      <SpinnerGapIcon size={16} className="animate-spin text-muted-foreground" />
                    ) : result.status === "success" ? (
                      <CheckCircleIcon size={16} className="text-green-500" />
                    ) : (
                      <XCircleIcon size={16} className="text-red-500" />
                    )}
                    <span className="font-medium">{result.providerName}</span>
                    <span
                      className={
                        result.status === "success"
                          ? "text-green-600 dark:text-green-400"
                          : result.status === "error"
                          ? "text-red-600 dark:text-red-400"
                          : "text-muted-foreground"
                      }
                    >
                      {result.message}
                    </span>
                  </div>
                  {result.latency !== undefined && result.status !== "testing" && (
                    <span className="text-xs text-muted-foreground tabular-nums bg-background/50 px-2 py-1 rounded">
                      {result.latency}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {diagnosticResults.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t("settings.providers.clickToTest")}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Connected Providers */}
      <SettingsSection
        title={t("settings.providers.connectedProviders")}
        description={
          sorted.length === 1
            ? t("settings.providers.connectedCount", { count: sorted.length })
            : t("settings.providers.connectedCountPlural", { count: sorted.length })
        }
      >
        <SettingsCard>
          <div className="px-4 py-3.5">
            <ProviderModelSelector
              providers={sorted}
              onEditProvider={handleEditProvider}
              onDeleteProvider={handleDelete}
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Add Provider */}
      <SettingsSection title={t("settings.providers.addProvider")} description={t("settings.providers.addProviderDesc")}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {chatPresets.map((preset) => (
            <div
              key={preset.key}
              className="group flex items-center gap-4 p-4 rounded-xl border border-border/50 bg-surface/50 hover:border-accent/30 hover:bg-accent/5 transition-all duration-200 cursor-pointer"
              onClick={() => handleOpenPresetDialog(preset)}
            >
              <div className="shrink-0 w-11 h-11 flex items-center justify-center group-hover:scale-105 transition-transform">
                <PresetIcon iconKey={preset.iconKey} size={28} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground">{preset.name}</div>
                <div className="text-xs text-muted-foreground truncate">{preset.descriptionZh}</div>
              </div>
              <div className="shrink-0 w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <PlusIcon size={16} />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDeleteTarget(null)} />
          <div className="relative z-10 w-full max-w-sm mx-4 bg-surface border border-border/50 rounded-xl shadow-xl p-5">
            <h3 className="text-sm font-semibold mb-2">{t("settings.providers.disconnectConfirmTitle")}</h3>
            <p className="text-xs text-muted-foreground mb-4">
              {t("settings.providers.disconnectConfirmDesc", { name: deleteTarget.name })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={confirmDelete}
                className="px-3 py-2 rounded-lg bg-destructive text-white text-sm font-medium hover:bg-destructive/90 transition-colors"
              >
                {t("settings.providers.disconnect")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connect/Edit Dialog */}
      <SimpleProviderDialog
        preset={selectedPreset}
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditProvider(null);
        }}
        onSave={handleSimpleSave}
        editProvider={editProvider}
      />
    </div>
  );
}

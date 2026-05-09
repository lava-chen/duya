"use client";

import { useState, useCallback, useEffect } from "react";
import {
  KeyIcon,
  GlobeIcon,
  SpinnerGapIcon,
  PlusIcon,
  NotePencilIcon,
  XIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
} from "@/components/icons";
import { ProviderConnectDialog, type ProviderFormData, type EditableProvider } from "./ProviderConnectDialog";
import { QUICK_PRESETS } from "@/lib/provider-presets";
import type { QuickPreset } from "@/lib/provider-presets";
import { PresetIcon } from "./PresetIcon";
import type { Provider } from "@/lib/ipc-client";
import {
  listProvidersIPC,
  upsertProviderIPC,
  updateProviderIPC,
  deleteProviderIPC,
} from "@/lib/ipc-client";

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

export function ProviderManager() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<QuickPreset | null>(null);
  const [editingProvider, setEditingProvider] = useState<EditableProvider | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      setError(null);
      const list = await listProvidersIPC();
      setProviders(list);
    } catch {
      setError("Failed to fetch providers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const handleOpenPresetDialog = (preset: QuickPreset) => {
    setSelectedPreset(preset);
    setEditingProvider(null);
    setDialogOpen(true);
  };

  const handleEdit = (provider: Provider) => {
    // Find matching preset
    const matchedPreset = QUICK_PRESETS.find(
      (p) => p.baseUrl === provider.baseUrl || p.key === provider.providerType
    );
    setSelectedPreset(matchedPreset || QUICK_PRESETS[0]);
    // Convert to snake_case for dialog
    setEditingProvider({
      id: provider.id,
      name: provider.name,
      provider_type: provider.providerType,
      base_url: provider.baseUrl,
      api_key: provider.apiKey,
      extra_env: provider.extraEnv,
      options_json: provider.options,
    });
    setDialogOpen(true);
  };

  const handleSave = async (data: ProviderFormData) => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      if (editingProvider) {
        // Update existing
        const updateData: Record<string, unknown> = {
          name: data.name,
          providerType: data.provider_type,
          baseUrl: data.base_url,
          extraEnv: data.extra_env,
        };
        if (!data.api_key.startsWith("***")) {
          updateData.apiKey = data.api_key;
        }
        if (data.options_json) {
          const opts = JSON.parse(data.options_json);
          // Extract default model from role_models_json if present
          if (data.role_models_json) {
            try {
              const roleModels = JSON.parse(data.role_models_json);
              if (roleModels.default) {
                opts.defaultModel = roleModels.default;
              }
            } catch {
              // ignore parse error
            }
          }
          // Fallback: use title_model or first enabled model if defaultModel still not set
          // (handles case where ProviderModelEditor was used instead of model_names field)
          if (!opts.defaultModel) {
            if (typeof opts.title_model === 'string' && opts.title_model.trim()) {
              opts.defaultModel = opts.title_model.trim();
            } else if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
              opts.defaultModel = opts.enabled_models[0];
            }
          }
          updateData.options = opts;
        }
        const updated = await updateProviderIPC(editingProvider.id, updateData);

        if (updated) {
          setSuccess("Provider updated");
          fetchProviders();
        } else {
          setError("Failed to update provider");
        }
      } else {
        // Create new
        // Generate a meaningful provider ID
        const existingIds = providers.map(p => p.id);
        const providerId = generateProviderId(data.provider_type, data.name, existingIds);
        console.log("[ProviderManager] Generated provider ID:", providerId);

        const created = await upsertProviderIPC({
          id: providerId,
          name: data.name,
          providerType: data.provider_type,
          baseUrl: data.base_url,
          apiKey: data.api_key,
          isActive: true,
          options: (() => {
            const opts = data.options_json ? JSON.parse(data.options_json) : {};
            // Extract default model from role_models_json if present
            if (data.role_models_json) {
              try {
                const roleModels = JSON.parse(data.role_models_json);
                if (roleModels.default) {
                  opts.defaultModel = roleModels.default;
                }
              } catch {
                // ignore parse error
              }
            }
            // Fallback: use title_model or first enabled model if defaultModel still not set
            // (handles case where ProviderModelEditor was used instead of model_names field)
            if (!opts.defaultModel) {
              if (typeof opts.title_model === 'string' && opts.title_model.trim()) {
                opts.defaultModel = opts.title_model.trim();
              } else if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
                opts.defaultModel = opts.enabled_models[0];
              }
            }
            return opts;
          })(),
        });

        if (created) {
          setSuccess("Provider connected");
          fetchProviders();
        } else {
          setError("Failed to create provider");
        }
      }
    } catch {
      setError("Failed to save provider");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (provider: Provider) => {
    setDeleteTarget(provider);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    setError(null);

    try {
      const deleted = await deleteProviderIPC(deleteTarget.id);
      if (deleted) {
        setSuccess("Provider disconnected");
        fetchProviders();
      } else {
        setError("Failed to delete provider");
      }
    } catch {
      setError("Failed to delete provider");
    } finally {
      setSaving(false);
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">Loading providers...</span>
      </div>
    );
  }

  const sorted = [...providers].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">API Providers</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage API providers for AI model access.
        </p>
      </div>

      {/* Error/Success Banners */}
      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-3">
          <p className="text-sm text-green-600">{success}</p>
        </div>
      )}

      {/* Connected Providers */}
      {sorted.length > 0 && (
        <div className="rounded-xl border border-border/50 bg-[var(--surface)] p-4">
          <h3 className="text-sm font-medium mb-3">Connected Providers</h3>
          <div className="space-y-2">
            {sorted.map((provider) => (
              <div
                key={provider.id}
                className={`flex items-center gap-3 py-2.5 px-2 rounded-lg ${
                  provider.isActive ? "bg-accent/5" : ""
                }`}
              >
                <div className="shrink-0 w-5 flex justify-center">
                  {provider.isActive ? (
                    <CheckCircleIcon size={16} className="text-accent" />
                  ) : (
                    <div className="h-4 w-4 rounded-full border-2 border-muted" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{provider.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-chip text-muted-foreground">
                      {provider.hasApiKey ? "Configured" : "No Key"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {provider.baseUrl || "default"} • {provider.hasApiKey ? "api key configured" : "no api key"}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => handleEdit(provider)}
                    className="p-1.5 rounded-lg hover:bg-chip text-muted-foreground hover:text-foreground"
                    title="Edit"
                  >
                    <NotePencilIcon size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(provider)}
                    className="p-1.5 rounded-lg hover:bg-chip text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <XIcon size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add Provider Section */}
      <div className="rounded-xl border border-border/50 bg-[var(--surface)] p-4">
        <h3 className="text-sm font-medium mb-3">Add Provider</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Select a provider to connect. Quick setup for popular AI services.
        </p>

        {/* Provider Presets */}
        <div className="space-y-2">
          {QUICK_PRESETS.map((preset) => (
            <div
              key={preset.key}
              className="flex items-center gap-3 py-2.5 px-2 rounded-lg border border-border/30 hover:border-accent/30 hover:bg-accent/5 transition-colors"
            >
              <div className="shrink-0 w-5 flex justify-center">
                <PresetIcon iconKey={preset.iconKey} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{preset.name}</span>
                <p className="text-xs text-muted-foreground truncate">
                  {preset.descriptionZh}
                </p>
              </div>
              <button
                onClick={() => handleOpenPresetDialog(preset)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border/50 bg-chip text-xs font-medium hover:bg-accent/10 hover:border-accent/50 shrink-0"
              >
                <PlusIcon size={12} />
                Connect
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDeleteTarget(null)}
          />
          <div className="relative z-10 w-full max-w-sm mx-4 bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl p-4">
            <h3 className="text-sm font-semibold mb-2">Disconnect Provider</h3>
            <p className="text-xs text-muted-foreground mb-4">
              Are you sure you want to disconnect &quot;{deleteTarget.name}&quot;? This action cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={saving}
                className="px-3 py-2 rounded-lg bg-destructive text-white text-sm font-medium hover:bg-destructive/90 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connect Dialog */}
      <ProviderConnectDialog
        preset={selectedPreset}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={handleSave}
        editProvider={editingProvider}
      />
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { XIcon, SpinnerGapIcon } from "@/components/icons";
import type { QuickPreset } from "@/lib/provider-presets";
import { getOllamaModelsIPC, testProviderIPC } from "@/lib/ipc-client";
import { PresetIcon } from "./PresetIcon";

// Get provider icon based on type and baseUrl (same logic as ProvidersSection)
function getProviderIcon(providerType: string, baseUrl: string | undefined) {
  const url = (baseUrl || "").toLowerCase();

  // Check URL first for specific providers
  if (url.includes("minimax")) return <PresetIcon iconKey="minimax" size={24} />;
  if (url.includes("anthropic")) return <PresetIcon iconKey="anthropic" size={24} />;
  if (url.includes("openrouter")) return <PresetIcon iconKey="openrouter" size={24} />;
  if (url.includes("bigmodel.cn") || url.includes("z.ai")) return <PresetIcon iconKey="zhipu" size={24} />;
  if (url.includes("kimi.com")) return <PresetIcon iconKey="kimi" size={24} />;
  if (url.includes("moonshot")) return <PresetIcon iconKey="moonshot" size={24} />;
  if (url.includes("volces.com") || url.includes("volcengine")) return <PresetIcon iconKey="volcengine" size={24} />;
  if (url.includes("bailian") || url.includes("dashscope")) return <PresetIcon iconKey="bailian" size={24} />;
  if (url.includes("bedrock") || url.includes("aws.amazon")) return <PresetIcon iconKey="bedrock" size={24} />;
  if (url.includes("vertex") || url.includes("google") || url.includes("gcp")) return <PresetIcon iconKey="google" size={24} />;
  if (url.includes("ollama") || url.includes("11434")) return <PresetIcon iconKey="ollama" size={24} />;

  // Then check provider type
  switch (providerType) {
    case "anthropic":
      return <PresetIcon iconKey="anthropic" size={24} />;
    case "openrouter":
      return <PresetIcon iconKey="openrouter" size={24} />;
    case "ollama":
      return <PresetIcon iconKey="ollama" size={24} />;
    case "bedrock":
      return <PresetIcon iconKey="bedrock" size={24} />;
    case "vertex":
      return <PresetIcon iconKey="google" size={24} />;
    case "openai-compatible":
      return <PresetIcon iconKey="server" size={24} />;
  }

  return <PresetIcon iconKey="server" size={24} />;
}

interface SimpleProviderDialogProps {
  preset: QuickPreset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: {
    name: string;
    provider_type: string;
    base_url: string;
    api_key: string;
    enabled_models: string[];
    auth_style?: string;
  }) => Promise<void>;
  editProvider?: {
    id: string;
    name: string;
    provider_type: string;
    base_url: string;
    api_key: string;
    options?: unknown;
  } | null;
}

export function SimpleProviderDialog({
  preset,
  open,
  onOpenChange,
  onSave,
  editProvider,
}: SimpleProviderDialogProps) {
  const isEdit = !!editProvider;
  const isOllama = preset?.provider_type === "ollama";

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Initialize form when dialog opens
  useEffect(() => {
    if (!open || !preset) return;

    if (isEdit && editProvider) {
      setName(editProvider.name);
      setBaseUrl(editProvider.base_url);
      setApiKey(editProvider.api_key || "");
      // Parse enabled models from options
      try {
        const opts = typeof editProvider.options === "object" && editProvider.options !== null
          ? editProvider.options
          : JSON.parse((editProvider.options as string) || "{}");
        setSelectedModels(opts.enabled_models || []);
      } catch {
        setSelectedModels([]);
      }
    } else {
      setName(preset.name);
      setBaseUrl(preset.baseUrl);
      setApiKey("");
      setSelectedModels([]);
    }
    setModels([]);
    setCustomModel("");
  }, [open, preset, isEdit, editProvider]);

  // Fetch Ollama models
  const fetchOllamaModels = async () => {
    if (!isOllama) return;
    setFetchingModels(true);
    try {
      const result = await getOllamaModelsIPC(baseUrl || "http://localhost:11434");
      if (result.success && result.models) {
        setModels(result.models.map((m) => m.id));
      }
    } catch (err) {
      console.error("Failed to fetch Ollama models:", err);
    } finally {
      setFetchingModels(false);
    }
  };

  // Test provider connection
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testProviderIPC({
        provider_type: preset!.provider_type,
        base_url: baseUrl.trim() || preset!.baseUrl,
        api_key: apiKey,
        model: selectedModels[0] || "",
        auth_style: preset!.authStyle,
      });
      setTestResult({
        success: result.success,
        message: result.success
          ? "Connection successful"
          : result.error?.message || "Connection failed",
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedModels.length === 0) {
      alert("Please select at least one model");
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: name.trim() || preset!.name,
        provider_type: preset!.provider_type,
        base_url: baseUrl.trim() || preset!.baseUrl,
        api_key: apiKey,
        enabled_models: selectedModels,
        auth_style: preset!.authStyle,
      });
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save provider:", err);
    } finally {
      setSaving(false);
    }
  };

  const toggleModel = (modelId: string) => {
    setSelectedModels((prev) =>
      prev.includes(modelId)
        ? prev.filter((m) => m !== modelId)
        : [...prev, modelId]
    );
  };

  const addCustomModel = () => {
    const id = customModel.trim();
    if (!id) return;
    if (!selectedModels.includes(id)) {
      setSelectedModels((prev) => [...prev, id]);
    }
    if (!models.includes(id)) {
      setModels((prev) => [...prev, id]);
    }
    setCustomModel("");
  };

  if (!open || !preset) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />
      <div className="relative z-10 w-full max-w-md mx-4 bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl max-h-[90vh] overflow-y-auto">
        {/* Header - only icon and close button */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
          {getProviderIcon(preset.provider_type, baseUrl)}
          <button
            onClick={() => onOpenChange(false)}
            className="p-1 rounded hover:bg-chip text-muted-foreground"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Base URL */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
              className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip font-mono"
            />
          </div>

          {/* API Key (not required for Ollama) */}
          {!isOllama && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip font-mono"
              />
            </div>
          )}

          {/* Model Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                Models ({selectedModels.length})
              </label>
              {isOllama && (
                <button
                  type="button"
                  onClick={fetchOllamaModels}
                  disabled={fetchingModels}
                  className="text-[11px] px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50"
                >
                  {fetchingModels ? (
                    <SpinnerGapIcon size={10} className="animate-spin inline" />
                  ) : (
                    "Fetch Local Models"
                  )}
                </button>
              )}
            </div>

            {/* Custom model input - Enter to add */}
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="Enter model name and press Enter"
              className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomModel();
                }
              }}
            />

            {/* Model list */}
            {models.length > 0 && (
              <div className="border border-border/50 rounded-lg max-h-40 overflow-y-auto">
                {models.map((model) => (
                  <label
                    key={model}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-chip cursor-pointer border-b border-border/30 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={selectedModels.includes(model)}
                      onChange={() => toggleModel(model)}
                      className="rounded border-border/50"
                    />
                    <span className="text-sm font-mono">{model}</span>
                  </label>
                ))}
              </div>
            )}

            {/* Selected models display */}
            {selectedModels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selectedModels.map((model) => (
                  <span
                    key={model}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/10 text-accent text-[11px]"
                  >
                    {model}
                    <button
                      type="button"
                      onClick={() => toggleModel(model)}
                      className="hover:text-accent/70"
                    >
                      <XIcon size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Test Result */}
          {testResult && (
            <div className={`text-xs px-3 py-2 rounded-lg ${testResult.success ? "bg-green-500/10 text-green-500" : "bg-destructive/10 text-destructive"}`}>
              {testResult.message}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={testConnection}
              disabled={testing}
              className="px-4 py-2 rounded-lg border border-border/50 text-sm hover:bg-chip disabled:opacity-50"
            >
              {testing ? (
                <SpinnerGapIcon size={14} className="animate-spin inline" />
              ) : (
                "Test"
              )}
            </button>
            <button
              type="submit"
              disabled={saving || selectedModels.length === 0}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
            >
              {saving ? (
                <SpinnerGapIcon size={14} className="animate-spin inline" />
              ) : (
                isEdit ? "Save" : "Add"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

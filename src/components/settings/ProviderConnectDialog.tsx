"use client";

/**
 * ProviderConnectDialog — Plan 203 Phase 2.5 slim version.
 *
 * State management is delegated to L2 hooks:
 * - `useApiKeyState`   — apiKey visibility + mask
 * - `useBaseUrlState`  — baseUrl + preset candidates
 * - `useModelSelection`— enabled models + custom models + ctx edit
 * - `usePresetDraft`   — preset → LlmProvider draft + validation
 *
 * The component still owns UI-only state (test result, ollama
 * model fetch, advanced section toggle, etc.) because none of
 * those are shared concerns. The hooks are unit-tested
 * independently; this file focuses on wiring.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  XIcon,
  ArrowUpRightIcon,
  CaretDownIcon,
  CaretUpIcon,
  EyeIcon,
  EyeSlashIcon,
} from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import type { QuickPreset } from "@/lib/provider-presets";
import { ProviderModelEditor } from "@/components/chat/ProviderModelEditor";
import { testProviderIPC, getOllamaModelsIPC, type OllamaModel } from "@/lib/ipc-client";
import { PresetIcon } from "./PresetIcon";
import { useApiKeyState } from "./forms/hooks/useApiKeyState";
import { useBaseUrlState } from "./forms/hooks/useBaseUrlState";
import { useModelSelection } from "./forms/hooks/useModelSelection";
import { usePresetDraft } from "./forms/hooks/usePresetDraft";
import { isMaskedKey } from "@/lib/providers/secret";

// AutoLink component to detect and render URLs as clickable links
function AutoLink({ text }: { text: string }) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);

  return (
    <>
      {parts.map((part, index) => {
        if (urlRegex.test(part)) {
          return (
            <a
              key={index}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-amber-700 dark:hover:text-amber-300"
            >
              {part}
            </a>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

interface ProviderConnectDialogProps {
  preset: QuickPreset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: ProviderFormData) => Promise<void>;
  editProvider?: EditableProvider | null;
}

export interface EditableProvider {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key: string;
  extra_env?: string;
  role_models_json?: string;
  options_json?: string;
  notes?: string;
}

export interface ProviderFormData {
  name: string;
  provider_type: string;
  protocol: string;
  base_url: string;
  api_key: string;
  extra_env: string;
  role_models_json?: string;
  enabled_models?: string[];
  options_json?: string;
  is_active?: boolean;
  /**
   * Plan 209 P3: user-editable note shown on the provider card
   * and used to disambiguate multiple accounts of the same
   * vendor. Optional — the onboarding flow now collects it but
   * keeps the type optional so existing callers keep compiling.
   */
  notes?: string;
}

export function ProviderConnectDialog({
  preset,
  open,
  onOpenChange,
  onSave,
  editProvider,
}: ProviderConnectDialogProps) {
  const { t, locale } = useTranslation();
  const isEdit = !!editProvider;

  // ── L2 hook state ──
  const apiKeyState = useApiKeyState({
    apiKey: editProvider?.api_key || "",
  });
  const baseUrlState = useBaseUrlState(
    { baseUrl: editProvider?.base_url },
    preset
      ? {
          defaultBaseUrl: preset.baseUrl,
          endpointCandidates: (preset as { endpointCandidates?: string[] }).endpointCandidates,
        }
      : undefined,
  );
  const modelSelection = useModelSelection({
    initialEnabled: useMemo(() => {
      // Populate enabled models from the edit provider's options_json.
      if (!editProvider) return [];
      try {
        const opts =
          typeof editProvider.options_json === "string"
            ? JSON.parse(editProvider.options_json || "{}")
            : editProvider.options_json || {};
        return (opts as { enabled_models?: string[] }).enabled_models || [];
      } catch {
        return [];
      }
    }, [editProvider]),
  });
  const presetDraft = usePresetDraft({
    initialPreset: preset,
    initialProviderId: editProvider?.id || "",
    initialName: editProvider?.name || preset?.name || "",
    initialApiKey: editProvider?.api_key || undefined,
    initialBaseUrl: editProvider?.base_url || preset?.baseUrl,
  });

  // ── UI-only state ──
  const [extraEnv, setExtraEnv] = useState("{}");
  const [modelName, setModelName] = useState("");
  const [mapSonnet, setMapSonnet] = useState("");
  const [mapOpus, setMapOpus] = useState("");
  const [mapHaiku, setMapHaiku] = useState("");
  const [titleModel, setTitleModel] = useState("");
  // Plan 209 P3: the new `ProviderEditView` exposes a "Notes"
  // input for distinguishing multiple accounts of the same
  // vendor (e.g. "company account" vs "personal"). The
  // onboarding dialog previously skipped this field — users
  // could only set it by editing later. Now we capture it at
  // add-time so the first-saved state is complete.
  const [notes, setNotes] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
    suggestion?: string;
  } | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [modelWarning, setModelWarning] = useState(false);

  // Show warning when baseUrl is filled but modelName is empty
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!preset) return;
      const hasBaseUrl = !!(baseUrlState.baseUrl.trim() || preset.baseUrl);
      const needsModel = preset.fields.includes("model_names");
      setModelWarning(hasBaseUrl && needsModel && !modelName.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [baseUrlState.baseUrl, modelName, preset]);

  // Reset form on dialog open / preset / editProvider change
  useEffect(() => {
    if (!open || !preset) return;
    setError(null);
    setSaving(false);
    setTesting(false);
    setTestResult(null);
    setShowAdvanced(false);
    setOllamaModels([]);
    setFetchModelsError(null);
    setShowModelSelector(false);

    if (isEdit && editProvider) {
      presetDraft.setName(editProvider.name);
      baseUrlState.setBaseUrl(editProvider.base_url);
      setExtraEnv(editProvider.extra_env || JSON.stringify(preset.defaultEnvOverrides));
      // Plan 209: the hook auto-detects a mask in `apiKey` and
      // keeps it as `maskedApiKey` with `keyState: 'untouched'`.
      // Forwarding the same value through `setApiKey` here would
      // flip to 'replaced' and re-introduce the pre-Plan-209 bug.
      if (!isMaskedKey(editProvider.api_key || "")) {
        apiKeyState.setApiKey(editProvider.api_key || "");
      }
      // Plan 209 P3: seed notes from the existing provider.
      setNotes(editProvider.notes || "");

      const firstPresetModel = preset.defaultModels?.[0]?.modelId || "";
      try {
        const rm = JSON.parse(editProvider.role_models_json || "{}");
        setModelName(rm.default || firstPresetModel);
        setMapSonnet(rm.sonnet || firstPresetModel);
        setMapOpus(rm.opus || firstPresetModel);
        setMapHaiku(rm.haiku || firstPresetModel);
      } catch {
        setModelName(firstPresetModel);
        setMapSonnet(firstPresetModel);
        setMapOpus(firstPresetModel);
        setMapHaiku(firstPresetModel);
      }
      try {
        const opts =
          typeof editProvider.options_json === "string"
            ? JSON.parse(editProvider.options_json || "{}")
            : editProvider.options_json || {};
        modelSelection.setEnabledFromProp(
          (opts as { enabled_models?: string[] }).enabled_models || [],
        );
        setTitleModel((opts as { title_model?: string }).title_model || "");
      } catch {
        modelSelection.setEnabledFromProp([]);
        setTitleModel("");
      }
    } else {
      baseUrlState.setBaseUrl(preset.baseUrl);
      presetDraft.setName(preset.name);
      setExtraEnv(JSON.stringify(preset.defaultEnvOverrides || {}));
      apiKeyState.setApiKey("");
      setNotes("");
      setModelName("");
      setMapSonnet("");
      setMapOpus("");
      setMapHaiku("");
      setTitleModel("");
      modelSelection.setEnabledFromProp(
        preset.defaultModels?.map((m) => m.upstreamModelId || m.modelId) || [],
      );
    }
    // We intentionally do not depend on the hook setters; they are
    // stable callbacks and re-running this effect would cause loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preset, isEdit, editProvider]);

  // Close model selector when clicking outside
  useEffect(() => {
    if (!showModelSelector) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".ollama-model-selector")) {
        setShowModelSelector(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelSelector]);

  if (!preset) return null;

  const isOllamaPreset =
    preset.key === "ollama" ||
    preset.provider_type === "ollama" ||
    (baseUrlState.baseUrl &&
      (baseUrlState.baseUrl.includes("11434") ||
        baseUrlState.baseUrl.includes("ollama")));

  // Fetch Ollama models
  const handleFetchOllamaModels = async () => {
    setFetchingModels(true);
    setFetchModelsError(null);
    setOllamaModels([]);

    try {
      const result = await getOllamaModelsIPC(baseUrlState.baseUrl || preset.baseUrl);
      if (result.success && result.models) {
        setOllamaModels(result.models);
        setShowModelSelector(true);
      } else {
        setFetchModelsError(result.error || t("provider.getModelsFailed"));
      }
    } catch (err) {
      setFetchModelsError(err instanceof Error ? err.message : t("provider.fetchModelsFailed"));
    } finally {
      setFetchingModels(false);
    }
  };

  const handleSelectOllamaModel = (modelId: string) => {
    setModelName(modelId);
    setShowModelSelector(false);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);

    try {
      const data = await testProviderIPC({
        provider_type: preset.provider_type,
        base_url: baseUrlState.baseUrl || preset.baseUrl,
        api_key: apiKeyState.apiKey,
        auth_style: preset.authStyle,
        model: modelName || preset.defaultModels?.[0]?.modelId || "",
      });

      if (data.success) {
        setTestResult({ success: true, message: data.message || t("provider.connectionSuccess") });
      } else {
        let errorMsg = data.error?.message || t("provider.connectionFailed");
        if (data.error?.code === "NO_MODEL") {
          errorMsg = t("provider.noModel");
        }
        setTestResult({
          success: false,
          error: errorMsg,
          suggestion: data.error?.suggestion,
        });
      }
    } catch {
      setTestResult({ success: false, error: t("provider.cannotConnect") });
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (preset.fields.includes("api_key") && apiKeyState.keyState !== "replaced" && !isEdit) {
      setError(t("provider.apiKeyRequired"));
      return;
    }

    // Build role_models_json from model mapping
    let roleModelsJson = "{}";
    const roleModels: Record<string, string> = {};
    const firstPresetModel = preset.defaultModels?.[0]?.modelId || "";
    if (firstPresetModel) roleModels.default = firstPresetModel;
    if (preset.fields.includes("model_names") && modelName.trim()) {
      roleModels.default = modelName.trim();
    }
    if (preset.fields.includes("model_mapping")) {
      const hasAny = mapSonnet.trim() || mapOpus.trim() || mapHaiku.trim();
      if (hasAny) {
        if (!mapSonnet.trim() || !mapOpus.trim() || !mapHaiku.trim()) {
          setError(t("provider.modelMappingRequired"));
          return;
        }
        roleModels.sonnet = mapSonnet.trim();
        roleModels.opus = mapOpus.trim();
        roleModels.haiku = mapHaiku.trim();
      }
    }
    if (Object.keys(roleModels).length > 0) {
      roleModelsJson = JSON.stringify(roleModels);
    }

    try {
      JSON.parse(extraEnv);
    } catch {
      setError(t("provider.invalidJson"));
      return;
    }

    setSaving(true);
    try {
      const optionsJson: Record<string, unknown> = {};
      const enabledList = Array.from(modelSelection.enabledModels);
      if (enabledList.length > 0) optionsJson.enabled_models = enabledList;
      if (titleModel.trim()) optionsJson.title_model = titleModel.trim();
      const optionsJsonString =
        Object.keys(optionsJson).length > 0 ? JSON.stringify(optionsJson) : undefined;

      // Plan 209: the dialog emits the legacy `api_key: string`
      // shape (consumed by `onSave`). When the user is in
      // 'untouched' state (existing edit), the apiKey is the
      // masked value — passing it through would re-introduce the
      // pre-Plan-209 bug. We forward '' in that case and let the
      // consumer's onSave figure out whether to keep the existing
      // credential (typically by re-reading the server).
      const apiKeyOut =
        apiKeyState.keyState === "replaced"
          ? apiKeyState.apiKey
          : apiKeyState.keyState === "cleared"
            ? ""
            : "";

      await onSave({
        name: presetDraft.draftLlmProvider?.name?.trim() || preset.name,
        provider_type: preset.provider_type,
        protocol: preset.protocol,
        base_url: baseUrlState.baseUrl.trim() || preset.baseUrl,
        api_key: apiKeyOut,
        extra_env: extraEnv,
        role_models_json: roleModelsJson,
        enabled_models: enabledList.length > 0 ? enabledList : undefined,
        options_json: optionsJsonString,
        notes: notes.trim() || undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("provider.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${
        open ? "" : "hidden"
      }`}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-[var(--main-bg)] border border-border/50 rounded-xl shadow-xl overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border/30 bg-[var(--main-bg)]">
          <div className="flex items-center gap-3">
            <div className="shrink-0 text-muted-foreground">
              <PresetIcon iconKey={preset.iconKey} />
            </div>
            <div>
              <h2 className="text-sm font-semibold">
                {isEdit ? t("provider.edit") : t("provider.connect")} {preset.name}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">{preset.descriptionZh}</p>
            </div>
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="p-1.5 rounded-lg hover:bg-chip text-muted-foreground hover:text-foreground"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* Meta info */}
        {preset.meta && (
          <div className="px-4 pt-3 pb-1">
            <div className="flex items-center gap-2 flex-wrap">
              {preset.meta.billingModel && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-chip text-muted-foreground border border-border/30">
                  {preset.meta.billingModel === "token_plan"
                    ? t("provider.tokenPlan")
                    : preset.meta.billingModel === "coding_plan"
                      ? t("provider.codingPlan")
                      : preset.meta.billingModel === "pay_as_you_go"
                        ? t("provider.payAsYouGo")
                        : preset.meta.billingModel === "free"
                          ? t("provider.free")
                          : preset.meta.billingModel}
                </span>
              )}
              {preset.meta.apiKeyUrl && (
                <a
                  href={preset.meta.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                >
                  <ArrowUpRightIcon size={10} />
                  {t("onboarding.getApiKey")}
                </a>
              )}
            </div>
            {preset.meta.notes && preset.meta.notes.length > 0 && (
              <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                {preset.meta.notes.map((note, i) => (
                  <p key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
                    <AutoLink text={note} />
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {/* Name + Notes (side-by-side) */}
          {preset.fields.includes("name") && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("provider.name")}</label>
                <input
                  type="text"
                  value={presetDraft.draftLlmProvider?.name || ""}
                  onChange={(e) => presetDraft.setName(e.target.value)}
                  placeholder={preset.name}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t("provider.notes")}</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t("provider.notesPlaceholder")}
                  className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
              </div>
            </div>
          )}

          {/* Base URL */}
          {preset.fields.includes("base_url") && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Base URL</label>
              <input
                type="text"
                value={baseUrlState.baseUrl}
                onChange={(e) => baseUrlState.setBaseUrl(e.target.value)}
                placeholder={preset.baseUrl}
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
              />
            </div>
          )}

          {/* API Key */}
          {preset.fields.includes("api_key") && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {preset.authStyle === "auth_token" ? "Auth Token" : "API Key"}
              </label>
              <div className="flex gap-2">
                <input
                  type={apiKeyState.revealApiKey ? "text" : "password"}
                  value={apiKeyState.apiKey}
                  onChange={(e) => apiKeyState.setApiKey(e.target.value)}
                  placeholder={
                    apiKeyState.maskedApiKey
                      ? t("provider.apiKeyKeepCurrent")
                      : preset.authStyle === "auth_token"
                        ? "token-..."
                        : "sk-..."
                  }
                  className="flex-1 px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={apiKeyState.toggleReveal}
                  className="px-3 py-2 rounded-lg border border-border/50 bg-chip text-muted-foreground hover:text-foreground"
                >
                  {apiKeyState.revealApiKey ? <EyeSlashIcon size={14} /> : <EyeIcon size={14} />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t("provider.authMethod")}:{" "}
                {preset.authStyle === "auth_token"
                  ? "Authorization: Bearer ..."
                  : "X-Api-Key: ..."}
              </p>
            </div>
          )}

          {/* Model name */}
          {preset.fields.includes("model_names") && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("provider.modelName")}
                </label>
                {isOllamaPreset && (
                  <button
                    type="button"
                    onClick={handleFetchOllamaModels}
                    disabled={fetchingModels}
                    className="text-[11px] px-2 py-1 rounded bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {fetchingModels ? (
                      <span className="flex items-center gap-1">
                        <SpinnerGapIcon size={10} className="animate-spin" />
                        {t("configStep.fetching")}
                      </span>
                    ) : (
                      t("provider.localModels")
                    )}
                  </button>
                )}
              </div>

              <div className="relative">
                <input
                  type="text"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  placeholder={isOllamaPreset ? "llama3.2" : "ark-code-latest"}
                  className={`w-full px-3 py-2 rounded-lg border text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono ${
                    modelWarning
                      ? "border-destructive/70 focus:ring-destructive/50"
                      : "border-border/50"
                  }`}
                />

                {modelWarning && (
                  <p className="text-[11px] text-destructive mt-1">
                    {locale === "zh"
                      ? "请填写模型名称，Gateway 需要模型配置才能正常工作"
                      : "Model name is required - Gateway needs a model to function properly"}
                  </p>
                )}

                {isOllamaPreset && showModelSelector && ollamaModels.length > 0 && (
                  <div className="ollama-model-selector absolute z-20 mt-1 w-full bg-[var(--main-bg)] border border-border/50 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    <div className="p-1">
                      <div className="text-[10px] text-muted-foreground px-2 py-1 border-b border-border/30">
                        {locale === "zh"
                          ? `选择本地模型 (${ollamaModels.length}个)`
                          : `Select local model (${ollamaModels.length})`}
                      </div>
                      {ollamaModels.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => handleSelectOllamaModel(model.id)}
                          className="w-full text-left px-2 py-1.5 text-sm hover:bg-chip rounded flex items-center justify-between group"
                        >
                          <span className="font-mono">{model.name}</span>
                          {model.size && (
                            <span className="text-[10px] text-muted-foreground">
                              {(model.size / 1024 / 1024 / 1024).toFixed(1)} GB
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {isOllamaPreset && fetchModelsError && (
                <p className="text-[10px] text-destructive">
                  {t("configStep.fetchFailed")}
                  {fetchModelsError}
                </p>
              )}

              <p className="text-[10px] text-muted-foreground">
                {isOllamaPreset
                  ? t("provider.modelPlaceholder")
                  : t("provider.providerConsoleModels")}
              </p>
            </div>
          )}

          {/* Extra Env */}
          {preset.fields.includes("extra_env") && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                {t("provider.envVars")}
              </label>
              <textarea
                value={extraEnv}
                onChange={(e) => setExtraEnv(e.target.value)}
                placeholder='{"KEY": "value"}'
                className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono min-h-[80px] resize-none"
                rows={3}
              />
            </div>
          )}

          {/* Model Selection - show after provider is saved (edit mode) */}
          {isEdit && editProvider && (
            <ProviderModelEditor
              providerId={editProvider.id}
              enabledModelIds={Array.from(modelSelection.enabledModels)}
              onChange={(ids) => modelSelection.setEnabledFromProp(ids)}
            />
          )}

          {/* Title Model */}
          {isEdit && editProvider && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {t("provider.titleModel")}
              </label>
              <p className="text-[10px] text-muted-foreground">{t("provider.titleModelHint")}</p>
              <input
                type="text"
                value={titleModel}
                onChange={(e) => setTitleModel(e.target.value)}
                placeholder="claude-3-5-haiku-20241022"
                className="w-full px-3 py-1.5 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
              />
            </div>
          )}

          {/* Advanced options */}
          {!preset.fields.includes("extra_env") && (
            <>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {showAdvanced ? <CaretUpIcon size={12} /> : <CaretDownIcon size={12} />}
                {t("provider.advanced")}
              </button>

              {showAdvanced && (
                <div className="space-y-4 border-t border-border/50 pt-3">
                  {preset.fields.includes("model_mapping") && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t("provider.modelMapping")}
                      </label>
                      <p className="text-[10px] text-muted-foreground">
                        {t("provider.modelMappingHint")}
                      </p>
                      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
                        <span className="text-xs text-muted-foreground text-right">
                          {t("provider.Sonnet")}
                        </span>
                        <input
                          type="text"
                          value={mapSonnet}
                          onChange={(e) => setMapSonnet(e.target.value)}
                          placeholder="claude-sonnet-4-6"
                          className="w-full px-3 py-1.5 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
                        />
                        <span className="text-xs text-muted-foreground text-right">
                          {t("provider.Opus")}
                        </span>
                        <input
                          type="text"
                          value={mapOpus}
                          onChange={(e) => setMapOpus(e.target.value)}
                          placeholder="claude-opus-4-6"
                          className="w-full px-3 py-1.5 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
                        />
                        <span className="text-xs text-muted-foreground text-right">
                          {t("provider.Haiku")}
                        </span>
                        <input
                          type="text"
                          value={mapHaiku}
                          onChange={(e) => setMapHaiku(e.target.value)}
                          placeholder="claude-haiku-4-5"
                          className="w-full px-3 py-1.5 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono"
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      {t("provider.envVars")}
                    </label>
                    <textarea
                      value={extraEnv}
                      onChange={(e) => setExtraEnv(e.target.value)}
                      placeholder='{"KEY": "value"}'
                      className="w-full px-3 py-2 rounded-lg border border-border/50 text-sm bg-chip text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 font-mono min-h-[60px] resize-none"
                      rows={3}
                    />
                  </div>
                </div>
              )}
            </>
          )}

          {/* Test Result */}
          {testResult && (
            <div
              className={`rounded-lg px-3 py-2 text-sm border ${
                testResult.success
                  ? "bg-green-500/10 border-green-500/30 text-green-600"
                  : "bg-destructive/10 border-destructive/30 text-destructive"
              }`}
            >
              <div className="flex items-center gap-2">
                {testResult.success ? (
                  <CheckCircleIcon size={14} />
                ) : (
                  <XCircleIcon size={14} />
                )}
                {testResult.success ? testResult.message : testResult.error}
              </div>
              {!testResult.success && testResult.suggestion && (
                <p className="text-xs text-muted-foreground mt-1 pl-6">{testResult.suggestion}</p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg px-3 py-2 text-sm bg-destructive/10 border border-destructive/30 text-destructive">
              {error}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-border/30">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground"
            >
              {t("provider.cancel")}
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={
                  testing ||
                  (preset.fields.includes("api_key") &&
                    apiKeyState.keyState !== "replaced")
                }
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/50 bg-chip text-xs font-medium hover:bg-accent/10 disabled:opacity-50"
              >
                {testing ? (
                  <SpinnerGapIcon size={12} className="animate-spin" />
                ) : (
                  <CircleNotchIcon size={12} />
                )}
                {testing ? t("settings.providers.testing") : t("bridge.testConnection")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
              >
                {saving && <SpinnerGapIcon size={12} className="animate-spin" />}
                {isEdit ? t("provider.update") : t("provider.connect")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

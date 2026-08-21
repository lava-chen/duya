/**
 * src/components/providers/ProviderEditView.tsx
 *
 * Provider edit page — minimal, two-list layout:
 *
 *   ← Back     Edit <Provider Name>           [🗑 Delete]
 *
 *   ── 1. 服务商信息 ─────────────────────────────────────
 *   别名 (Alias)              [ 公司专用账号 ]
 *   显示名称 (Name)           [ MiniMax (CN) ]
 *   Base URL                 [ https://... ]
 *   API Key                  [ ••••• ] [👁]
 *   备注 (Notes)              [ ... ]            (optional)
 *
 *   ── 2. 模型 ───────────────────────────────────────────
 *   ⓘ 0 enabled                 [拉取模型列表] [清空]
 *   ✓ claude-sonnet-4-6             [200K][1M]   [✕]
 *   ✓ claude-sonnet-4-6-1m          [200K][1M]   [✕]
 *   ...
 *
 *   ── FOOTER (sticky) ──────────────────────────────────
 *                                  [取消] [测试连接] [保存]
 *
 * Design rules:
 * - Sections use no icon, just a plain title + description,
 *   so the layout matches the rest of Settings.
 * - Model list rows carry one `[200K]` / `[1M]` toggle. The active
 *   value is the closest preset <= the picked context; clicking the
 *   active one clears the override. The chosen context is
 *   persisted to `options.model_context[modelId]` in config.toml
 *   and resolved at runtime by `ProviderStore.resolveRuntimeCapability`,
 *   so the session agent picks the correct 1M model variant.
 * - The fetch button reads from the provider's API via
 *   `fetchProviderModelsIPC`; the resulting models merge with the
 *   built-in catalog defaults so unknown models still appear.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  ArrowLeftIcon,
  TrashIcon,
  XIcon,
  CheckIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import {
  SettingsSection,
  SettingsCard,
  SettingsInputRow,
} from '@/components/settings/ui';
import { useApiKeyState } from '@/components/settings/forms/hooks/useApiKeyState';
import { useBaseUrlState } from '@/components/settings/forms/hooks/useBaseUrlState';
import { useModelSelection } from '@/components/settings/forms/hooks/useModelSelection';
import { usePresetDraft } from '@/components/settings/forms/hooks/usePresetDraft';
import { useProviderModels } from '@/components/providers/hooks/useProviderModels';
import { ModelCapabilityBadges } from '@/components/providers/ModelCapabilityBadges';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { useProviderEditSave } from '@/lib/providers/hooks/useProviderEditSave';
import { isMaskedKey } from '@/lib/providers/secret';
import { getPreset, findPresetByBaseUrl, type QuickPreset } from '@/lib/provider-presets';
import { useConversationStore } from '@/stores/conversation-store';
import { cn } from '@/lib/utils';
import {
  testProviderIPC,
  type FetchedModel,
} from '@/lib/ipc-client';

const CONTEXT_PRESETS: Array<{ value: number; label: string }> = [
  { value: 200_000, label: '200K' },
  { value: 1_000_000, label: '1M' },
];

/** Resolve the "currently picked" context preset for a model, or
 *  null when the user has cleared the override. Picks the largest
 *  preset that is <= the current value (so 200K lights up for a
 *  200K pick, 1M lights up for a 1M pick). */
function activeContextPreset(
  ctx: number | null | undefined,
): { value: number; label: string } | null {
  if (!ctx || ctx <= 0) return null;
  for (let i = CONTEXT_PRESETS.length - 1; i >= 0; i--) {
    if (CONTEXT_PRESETS[i].value <= ctx) return CONTEXT_PRESETS[i];
  }
  return null;
}

/** Human-readable tokens: 262144 -> "256K", 131072 -> "128K", 8192 -> "8K". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  const k = n / 1000;
  if (n >= 1000) return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  return String(n);
}

export function ProviderEditView() {
  const { t, locale } = useTranslation();
  const target = useConversationStore((s) => s.providerEditTarget);
  const setSettingsTab = useConversationStore((s) => s.setSettingsTab);
  const clearProviderEdit = useConversationStore((s) => s.clearProviderEdit);
  const { data: providers = [] } = useProvidersQuery();
  const { save, isPending: saving } = useProviderEditSave();

  // ── Resolve target → (preset, editProvider) pair ──
  const preset: QuickPreset | null = useMemo(() => {
    if (!target) return null;
    if (target.presetKey) return getPreset(target.presetKey) ?? null;
    if (target.providerId) {
      const p = providers.find((p) => p.id === target.providerId);
      if (!p) return null;
      const byBase = findPresetByBaseUrl(p.baseUrl);
      if (byBase) return byBase;
      return {
        key: p.id,
        provider_type: p.protocol,
        name: p.name,
        description: '',
        descriptionZh: p.name,
        protocol: p.protocol as never,
        authStyle: 'api_key' as never,
        baseUrl: p.baseUrl,
        defaultEnvOverrides: {},
        defaultModels: [],
        fields: ['name', 'api_key', 'base_url'],
        iconKey: 'server',
      };
    }
    return null;
  }, [target, providers]);

  const editProvider = useMemo(() => {
    if (!target?.providerId) return null;
    return providers.find((p) => p.id === target.providerId) ?? null;
  }, [target, providers]);

  const isEdit = !!editProvider;

  const initialEnabled = useMemo(() => {
    if (!editProvider) {
      // For new providers, seed enabled models from the preset's
      // catalog defaults so the user sees them immediately without
      // needing to fetch from the API first.
      return preset?.defaultModels?.map((m) => m.modelId) ?? [];
    }
    try {
      const opts =
        typeof editProvider.options === 'string'
          ? JSON.parse(editProvider.options || '{}')
          : editProvider.options || {};
      const explicit = (opts as { enabled_models?: string[] }).enabled_models;
      if (explicit && explicit.length > 0) return explicit;
      const fallback = (opts as { defaultModel?: string }).defaultModel;
      return fallback ? [fallback] : [];
    } catch {
      return [];
    }
  }, [editProvider, preset]);

  // Per-model context windows are persisted in two places (legacy DB
  // capability rows + the new `options.model_context` map in
  // config.toml). The view hydrates a single map for the form by
  // preferring the config map and falling back to the capability
  // table — so the `[1M] / [200K]` buttons reflect what the session
  // agent will actually use at runtime.
  const [initialContextWindows, setInitialContextWindows] = useState<
    Record<string, number>
  >({});

  // User-editable alias (nickname). Independent of the vendor `name`.
  const [alias, setAlias] = useState('');

  // Hydrate `initialContextWindows` and `alias` from the edit
  // provider DTO whenever the user lands on / switches to a
  // different provider. Reads the `options.model_context` map from
  // config.toml directly — no async IPC needed since the DTO already
  // carries the parsed options.
  useEffect(() => {
    if (!editProvider) {
      setInitialContextWindows({});
      setAlias('');
      return;
    }
    let opts: Record<string, unknown> = {};
    try {
      opts =
        typeof editProvider.options === 'string'
          ? JSON.parse(editProvider.options || '{}')
          : editProvider.options || {};
    } catch {
      opts = {};
    }
    const ctxMap = opts.model_context as Record<string, number> | undefined;
    if (ctxMap && typeof ctxMap === 'object') {
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(ctxMap)) {
        if (typeof v === 'number' && v > 0) next[k] = v;
      }
      setInitialContextWindows(next);
    } else {
      setInitialContextWindows({});
    }
    setAlias(editProvider.alias ?? '');
  }, [editProvider?.id, editProvider?.options, editProvider]);

  // Catalog default models for the selected preset, mapped to
  // FetchedModel shape so they seed the model list immediately.
  const presetModels = useMemo<FetchedModel[]>(
    () =>
      (preset?.defaultModels ?? []).map((m) => ({
        id: m.modelId,
        name: m.displayName,
        ownedBy: 'preset',
      })),
    [preset],
  );

  // ── Hook state ──
  const modelSelection = useModelSelection({ initialEnabled });
  const apiKeyState = useApiKeyState({ apiKey: editProvider?.apiKey ?? '' });
  const baseUrlState = useBaseUrlState(
    { baseUrl: editProvider?.baseUrl },
    preset
      ? {
          defaultBaseUrl: preset.baseUrl,
          endpointCandidates: (preset as { endpointCandidates?: string[] })
            .endpointCandidates,
        }
      : undefined,
  );
  const presetDraft = usePresetDraft({
    initialPreset: preset ?? undefined,
    initialProviderId: editProvider?.id || '',
    initialName: editProvider?.name || preset?.name || '',
    initialApiKey: editProvider?.apiKey ?? undefined,
    initialBaseUrl: editProvider?.baseUrl || preset?.baseUrl,
  });

  const models = useProviderModels({
    // Plan 209 fix-up: forward the provider id so the IPC
    // handler can resolve the on-disk api_key (the renderer
    // only ever sees the masked hint) and so `setContextWindow`
    // can persist user picks to the capability table.
    providerId: editProvider?.id,
    protocol: preset?.protocol ?? '',
    authStyle: preset?.authStyle,
    baseUrl: baseUrlState.baseUrl,
    // The IPC handler will resolve this: if the user has not
    // typed a new key (state === 'untouched'), the masked hint
    // is harmless — the handler uses the on-disk key instead.
    // If the user has typed a new key, the real value is
    // forwarded as-is.
    apiKey: apiKeyState.apiKey || apiKeyState.maskedApiKey,
    initialEnabled,
    initialContextWindows,
    // Seed the model list with catalog defaults so the user
    // sees available models immediately without needing to
    // configure API key + fetch first.
    presetModels,
  });

  useEffect(() => {
    modelSelection.setEnabledFromProp(models.enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.enabled.join('|')]);

  // ── UI-only state ──
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
    suggestion?: string;
  } | null>(null);

  // Auth Token show/hide (local state — not persisted).
  const [apiKeyRevealed, setApiKeyRevealed] = useState(false);

  useEffect(() => {
    if (!preset) return;
    setError(null);
    setTesting(false);
    setTestResult(null);

    if (isEdit && editProvider) {
      presetDraft.setName(editProvider.name);
      baseUrlState.setBaseUrl(editProvider.baseUrl);
      setNotes(editProvider.notes || '');
      // Plan 209 parity with `ProviderConnectDialog`: the hook
      // auto-detects a mask in `apiKey` and keeps it as
      // `maskedApiKey` with `keyState: 'untouched'`. Forwarding
      // the masked value through `setApiKey` here would flip to
      // 'replaced' and re-introduce the pre-Plan-209 bug
      // (electron rejects the save with `code: 'masked_key'`).
      if (!isMaskedKey(editProvider.apiKey || '')) {
        apiKeyState.setApiKey(editProvider.apiKey || '');
      } else {
        apiKeyState.setMasked(editProvider.apiKey || '');
      }
    } else {
      baseUrlState.setBaseUrl(preset.baseUrl);
      presetDraft.setName(preset.name);
      apiKeyState.setApiKey('');
      setNotes('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, isEdit, editProvider?.id]);

  if (!target) {
    return (
      <BackFallback
        onBack={() => setSettingsTab('providers')}
        t={t as unknown as (key: string, params?: unknown) => string}
      />
    );
  }
  if (!preset) {
    return (
      <BackFallback
        onBack={() => {
          clearProviderEdit();
          setSettingsTab('providers');
        }}
        t={t as unknown as (key: string, params?: unknown) => string}
        loading
      />
    );
  }

  const handleBack = () => {
    clearProviderEdit();
    setSettingsTab(isEdit ? 'providers' : 'provider-picker');
  };

  const handleAddFromList = (modelId: string) => {
    models.enable(modelId);
  };

  const handleRemoveModel = (modelId: string) => {
    models.disable(modelId);
  };

  const handleSetContextWindow = (modelId: string, ctx: number) => {
    models.setContextWindow(modelId, ctx);
  };

  const handleClearAll = () => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        locale === 'zh'
          ? '确定要清空所有已启用的模型吗？'
          : 'Are you sure you want to clear all enabled models?',
      );
      if (!ok) return;
    }
    for (const m of [...models.enabled]) models.disable(m);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    const firstEnabled =
      models.enabled[0] || preset.defaultModels?.[0]?.modelId || '';
    try {
      const data = await testProviderIPC({
        provider_type: preset.provider_type,
        base_url: baseUrlState.baseUrl || preset.baseUrl,
        // Plan 209: same fallback as the model fetch — when
        // the hook is in 'untouched' state the raw `apiKey`
        // is empty, so we hand the masked hint to the IPC.
        // The server treats it as a normal value (which 401s)
        // and the user re-types the real key to retry.
        api_key: apiKeyState.apiKey || apiKeyState.maskedApiKey,
        auth_style: preset.authStyle,
        model: firstEnabled,
      });
      if (data.success) {
        setTestResult({
          success: true,
          message: data.message || t('provider.connectionSuccess'),
        });
      } else {
        let errorMsg = data.error?.message || t('provider.connectionFailed');
        if (data.error?.code === 'NO_MODEL') errorMsg = t('provider.noModel');
        setTestResult({
          success: false,
          error: errorMsg,
          suggestion: data.error?.suggestion,
        });
      }
    } catch {
      setTestResult({ success: false, error: t('provider.cannotConnect') });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = () => {
    if (!editProvider) return;
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        locale === 'zh'
          ? `确定要删除 "${editProvider.name}" 吗？此操作无法撤销。`
          : `Are you sure to delete "${editProvider.name}"? This action cannot be undone.`,
      );
      if (!ok) return;
    }
    window.dispatchEvent(
      new CustomEvent('duya:provider-delete', { detail: { id: editProvider.id } }),
    );
    clearProviderEdit();
    setSettingsTab('providers');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (
      preset.fields.includes('api_key') &&
      !isEdit &&
      apiKeyState.keyState !== 'replaced'
    ) {
      setError(t('provider.apiKeyRequired'));
      return;
    }

    const optionsJson: Record<string, unknown> = {};
    if (models.enabled.length > 0) {
      optionsJson.enabled_models = models.enabled;
      optionsJson.defaultModel = models.enabled[0];
    }

    // Per-model context windows from the [200K]/[1M] toggles.
    // Only emit positive values — clicking the active preset
    // clears it. The map is persisted to config.toml as
    // `options.model_context` and consumed at runtime by
    // `ProviderStore.resolveRuntimeCapability` so the session
    // agent picks the correct 1M model variant.
    const ctxMap: Record<string, number> = {};
    for (const [modelId, ctx] of models.contextWindows.entries()) {
      if (typeof ctx === 'number' && ctx > 0) ctxMap[modelId] = ctx;
    }
    if (Object.keys(ctxMap).length > 0) {
      optionsJson.model_context = ctxMap;
    }

    const optionsJsonString =
      Object.keys(optionsJson).length > 0 ? JSON.stringify(optionsJson) : undefined;

    const apiKeyArg: string | undefined =
      apiKeyState.keyState === 'replaced'
        ? apiKeyState.apiKey
        : apiKeyState.keyState === 'cleared'
          ? ''
          : undefined;

    const aliasTrimmed = alias.trim();

    try {
      await save(
        {
          name: presetDraft.draftLlmProvider?.name?.trim() || preset.name,
          alias: aliasTrimmed || undefined,
          provider_type: preset.provider_type,
          protocol: preset.protocol,
          base_url: baseUrlState.baseUrl.trim() || preset.baseUrl,
          api_key: apiKeyArg,
          // Preserve the existing on-disk env vars so we
          // don't accidentally wipe them on save. The UI no
          // longer exposes them, but the field still exists on
          // the disk schema and may carry preset defaults like
          // `API_TIMEOUT_MS`.
          extra_env:
            editProvider?.extraEnv && editProvider.extraEnv !== '{}'
              ? editProvider.extraEnv
              : JSON.stringify(preset.defaultEnvOverrides || {}),
          enabled_models: models.enabled,
          options: optionsJson,
          options_json: optionsJsonString,
          notes: notes.trim() || undefined,
          preset_id: target?.presetKey,
          existing_provider_dto: editProvider
            ? {
                headers: editProvider.headers,
                extraEnv: editProvider.extraEnv,
                notes: editProvider.notes,
              }
            : undefined,
        },
        editProvider?.id ?? null,
      );
      clearProviderEdit();
      setSettingsTab('providers');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'masked_key') {
        setError(t('provider.maskedKeyRejected'));
      } else {
        setError(e?.message ?? t('provider.saveFailed'));
      }
    }
  };

  // ── Render data ──
  const enabledSet = new Set(models.enabled);

  // The "display value" for the Auth Token input. When the
  // hook is in 'cleared' state we show ''; otherwise show the
  // raw value if present, or the masked value as a hint.
  const apiKeyDisplay =
    apiKeyState.keyState === 'cleared'
      ? ''
      : apiKeyState.apiKey || apiKeyState.maskedApiKey;

  return (
    <div data-testid="provider-edit-view" className="max-w-3xl pb-24">
      {/* ── HEADER (back + page title) ─────────── */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            data-testid="provider-edit-back"
            className="shrink-0"
          >
            <ArrowLeftIcon size={16} />
            <span className="hidden sm:inline">{t('common.back')}</span>
          </Button>
          <h1 className="text-lg font-semibold truncate">
            {isEdit ? t('provider.edit') : t('provider.connect')}{' '}
            {preset.name}
          </h1>
        </div>
        {isEdit && (
          <Button
            variant="danger"
            size="sm"
            onClick={handleDelete}
            data-testid="provider-edit-delete"
            className="shrink-0"
          >
            <TrashIcon size={14} />
            <span className="hidden sm:inline">{t('provider.delete')}</span>
          </Button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* ── LIST 1: 服务商信息 ───────────────────────── */}
        <SettingsSection
          title={
            locale === 'zh' ? '服务商信息' : 'Service information'
          }
          description={
            locale === 'zh'
              ? '设置别名、显示名、连接参数与凭据。'
              : 'Alias, display name, connection and credentials.'
          }
        >
          <SettingsCard divided>
            {/* Alias — editable */}
            <SettingsInputRow
              label={locale === 'zh' ? '别名' : 'Alias'}
              description={
                locale === 'zh'
                  ? '用于区分同一服务商的多个账号，例如「公司专用」「个人」。'
                  : 'Distinguish multiple accounts of the same vendor, e.g. "Work", "Personal".'
              }
              value={alias}
              onChange={setAlias}
              placeholder={
                locale === 'zh' ? '选填,留空使用显示名' : 'Optional, falls back to display name'
              }
              data-testid="provider-edit-alias"
            />

            {/* Display name — editable */}
            <SettingsInputRow
              label={locale === 'zh' ? '显示名称' : 'Display name'}
              value={presetDraft.draftLlmProvider?.name || ''}
              onChange={(v) => presetDraft.setName(v)}
              placeholder={preset.name}
            />

            {/* Base URL */}
            {preset.fields.includes('base_url') && (
              <SettingsInputRow
                label={locale === 'zh' ? 'Base URL' : 'Base URL'}
                value={baseUrlState.baseUrl}
                onChange={(v) => baseUrlState.setBaseUrl(v)}
                placeholder={preset.baseUrl}
              />
            )}

            {/* Auth Token — real editable input with show/hide */}
            {preset.fields.includes('api_key') && (
              <SettingsInputRow
                label={
                  preset.authStyle === 'auth_token' ? 'Auth Token' : 'API Key'
                }
                description={`${t('provider.authMethod')}: ${
                  preset.authStyle === 'auth_token'
                    ? 'Authorization: Bearer ...'
                    : 'X-Api-Key: ...'
                }`}
                value={apiKeyDisplay}
                onChange={(v) => apiKeyState.setApiKey(v)}
                placeholder={
                  preset.authStyle === 'auth_token' ? 'token-...' : 'sk-...'
                }
                type={apiKeyRevealed ? 'text' : 'password'}
              />
            )}

            {/* Show/Hide button — under the API Key row. */}
            {preset.fields.includes('api_key') && (
              <div className="px-4 py-2 flex justify-end border-t border-border/30">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setApiKeyRevealed((v) => !v)}
                >
                  {apiKeyRevealed
                    ? t('provider.hideKey')
                    : t('provider.showKey')}
                </Button>
              </div>
            )}

            {/* Notes (备注) — optional. */}
            <SettingsInputRow
              label={locale === 'zh' ? '备注' : 'Notes'}
              value={notes}
              onChange={setNotes}
              placeholder={
                locale === 'zh'
                  ? '选填,例如账号用途'
                  : 'Optional, e.g. account purpose'
              }
            />
          </SettingsCard>
        </SettingsSection>

        {/* ── LIST 2: 模型 ──────────────────────────────── */}
        <SettingsSection
          title={locale === 'zh' ? '模型' : 'Models'}
          description={
            locale === 'zh'
              ? '从此服务商的可用模型中勾选要启用的项。点击 [200K] / [1M] 切换上下文长度,选择会保存到 config 并立即作用于会话。'
              : 'Enable the models you want to use. Toggle [200K] / [1M] to pick the context window — the choice is persisted to config and applied to the session agent immediately.'
          }
          action={
            <div className="flex items-center gap-1.5">
              {models.enabled.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearAll}
                >
                  {t('provider.clearAll')}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => models.fetch()}
                disabled={models.isFetching}
                data-testid="provider-edit-fetch-models"
              >
                {models.isFetching && (
                  <SpinnerGapIcon size={12} className="animate-spin" />
                )}
                {t('provider.modelInput.fetch')}
              </Button>
            </div>
          }
        >
          <SettingsCard divided={false}>
            {models.fetchError && (
              <div
                data-testid="provider-edit-models-error"
                className="px-4 py-2.5 text-sm text-destructive flex items-center gap-2 border-b border-border/30"
              >
                <XCircleIcon size={14} />
                {models.fetchError}
              </div>
            )}

            {/* Empty state */}
            {models.enabled.length === 0 ? (
              <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('provider.modelInput.noEnabledHint')}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => models.fetch()}
                  disabled={models.isFetching}
                  className="hover:underline"
                >
                  {models.isFetching && (
                    <SpinnerGapIcon size={12} className="animate-spin" />
                  )}
                  {t('provider.modelInput.fetch')}
                </Button>
              </div>
            ) : (
              <ul
                data-testid="provider-edit-enabled-list"
                className="divide-y divide-border/20"
              >
                {models.enabled.map((modelId) => {
                  const ctx = models.contextWindows.get(modelId) ?? null;
                  const activePreset = activeContextPreset(ctx);
                  // Look up rich capability flags from the fetched
                  // list (populated by `useProviderModels` after a
                  // successful `/api/v1/models` roundtrip). Enabled
                  // rows whose model id is not in the fetched list
                  // simply render no badges — caller-friendly.
                  const fetched = models.fetched.find((m) => m.id === modelId);
                  return (
                    <li
                      key={modelId}
                      data-testid={`provider-edit-enabled-row-${modelId}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors"
                    >
                      <CheckIcon
                        size={12}
                        className="text-accent shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-mono truncate">
                            {modelId}
                          </span>
                          <ModelCapabilityBadges
                            variant="inline"
                            vision={fetched?.supportsVision}
                            toolUse={fetched?.supportsToolUse}
                            reasoning={fetched?.supportsReasoning}
                            format={fetched?.format}
                            isLoaded={fetched?.isLoaded}
                          />
                        </div>
                        {ctx != null && ctx > 0 && (
                          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                            context {formatTokens(ctx)}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        {CONTEXT_PRESETS.map((presetCtx) => {
                          const active = activePreset?.value === presetCtx.value;
                          return (
                            <button
                              key={presetCtx.value}
                              type="button"
                              onClick={() =>
                                handleSetContextWindow(
                                  modelId,
                                  active ? 0 : presetCtx.value,
                                )
                              }
                              data-testid={`provider-edit-ctx-${modelId}-${presetCtx.label}`}
                              className={cn(
                                'px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors',
                                active
                                  ? 'bg-accent/20 text-accent'
                                  : 'text-muted-foreground/70 hover:text-foreground',
                              )}
                            >
                              {presetCtx.label}
                            </button>
                          );
                        })}
                      </div>
                      <IconButton
                        variant="danger"
                        size="sm"
                        aria-label={t('provider.remove')}
                        onClick={() => handleRemoveModel(modelId)}
                        data-testid={`provider-edit-remove-${modelId}`}
                        className="shrink-0"
                      >
                        <XIcon size={12} />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add model — plain text search + add buttons. No
                portal-based select needed: the model list is a
                plain list and we only need to surface what the
                fetch returned. The user types an id to add. */}
            <div className="px-4 py-3 border-t border-border/30 space-y-2">
              {models.fetched.length > 0 ? (
                <details className="group">
                  <summary
                    className="cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none"
                    data-testid="provider-edit-add-toggle"
                  >
                    +{' '}
                    {locale === 'zh'
                      ? `从已拉取的 ${models.fetched.length} 个模型中添加`
                      : `Add from ${models.fetched.length} fetched models`}
                  </summary>
                  <ul className="mt-2 max-h-48 overflow-y-auto rounded border border-border/30 bg-muted/30">
                    {models.fetched
                      .filter((m) => !enabledSet.has(m.id))
                      .map((m) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => handleAddFromList(m.id)}
                            className="w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-accent/10 transition-colors flex items-center gap-2"
                            data-testid={`provider-edit-add-${m.id}`}
                          >
                            <span className="truncate">{m.id}</span>
                            <ModelCapabilityBadges
                              variant="inline"
                              vision={m.supportsVision}
                              toolUse={m.supportsToolUse}
                              reasoning={m.supportsReasoning}
                              format={m.format}
                              isLoaded={m.isLoaded}
                            />
                            {m.ownedBy ? (
                              <span className="ml-auto text-muted-foreground/70 shrink-0">
                                {m.ownedBy}
                              </span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    {models.fetched.filter((m) => !enabledSet.has(m.id))
                      .length === 0 && (
                      <li className="px-3 py-2 text-xs text-muted-foreground">
                        {t('provider.modelInput.noMatch')}
                      </li>
                    )}
                  </ul>
                </details>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => models.fetch()}
                  disabled={models.isFetching}
                  className="w-full border-dashed"
                >
                  {models.isFetching && (
                    <SpinnerGapIcon size={12} className="animate-spin" />
                  )}
                  {t('provider.fetchFirstHint')}
                </Button>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>

        {/* ── Inline status (non-blocking) ──────────── */}
        {testResult && (
          <div
            data-testid="provider-edit-test-result"
            className={cn(
              'rounded-md px-3 py-2 text-sm flex items-start gap-2',
              testResult.success
                ? 'bg-green-500/10 text-green-600'
                : 'bg-destructive/10 text-destructive',
            )}
          >
            {testResult.success ? (
              <CheckCircleIcon size={14} className="mt-0.5 shrink-0" />
            ) : (
              <XCircleIcon size={14} className="mt-0.5 shrink-0" />
            )}
            <div className="flex-1">
              {testResult.success ? testResult.message : testResult.error}
              {!testResult.success && testResult.suggestion && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {testResult.suggestion}
                </p>
              )}
            </div>
          </div>
        )}

        {error && (
          <div
            data-testid="provider-edit-error"
            className="rounded-md px-3 py-2 text-sm bg-destructive/10 text-destructive"
          >
            {error}
          </div>
        )}

        {/* ── FOOTER (sticky, separated) ──────────── */}
        <div
          className="sticky bottom-0 -mx-4 px-4 py-3 border-t border-border/30 bg-[var(--bg-canvas)]/85 backdrop-blur-sm flex items-center justify-end gap-2"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={handleBack}
          >
            {t('provider.cancel')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTestConnection}
            disabled={
              testing ||
              models.enabled.length === 0 ||
              // Plan 209: keep the button enabled when the hook
              // is in 'untouched' state — the masked hint counts
              // as "we have a value to test with", even though
              // the test will 401. Disabling it would prevent
              // the user from confirming the on-disk key works
              // (e.g. after re-importing settings from backup).
              (!apiKeyState.apiKey &&
                !apiKeyState.maskedApiKey &&
                preset.fields.includes('api_key'))
            }
            data-testid="provider-edit-test-connection"
          >
            {testing ? (
              <SpinnerGapIcon size={12} className="animate-spin" />
            ) : (
              <CircleNotchIcon size={14} />
            )}
            {testing
              ? t('settings.providers.testing')
              : t('bridge.testConnection')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={saving}
            data-testid="provider-edit-save"
          >
            {saving && <SpinnerGapIcon size={12} className="animate-spin" />}
            {isEdit ? t('provider.update') : t('provider.connect')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function BackFallback({
  onBack,
  t,
  loading,
}: {
  onBack: () => void;
  t: (key: string, params?: unknown) => string;
  loading?: boolean;
}) {
  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
      >
        <ArrowLeftIcon size={16} />
        {t('common.back')}
      </Button>
      <p className="text-sm text-muted-foreground">
        {loading ? t('provider.loading') : t('provider.noProviders')}
      </p>
    </div>
  );
}

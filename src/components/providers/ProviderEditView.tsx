/**
 * src/components/providers/ProviderEditView.tsx
 *
 * Plan 209 + redesign: inline edit page (NOT a modal) for
 * configuring a single provider. Modeled after the cc-switch /
 * Claude-Code / Codex settings layout:
 *
 *   ← Back     Edit <Provider Name>           [🗑 Delete]
 *
 *   ── 1. IDENTITY ──────────────────────────────
 *   Identity                    miniamx-cn          (read-only pill)
 *   Display Name                [ MiniMax (CN) ]     (editable)
 *   Notes                       [ 公司专用账号 ]     (editable)
 *
 *   ── 2. CONNECTION ────────────────────────────
 *   Website                                       [打开 ↗]
 *   Get API Key                                    [打开 ↗]
 *   API format                 anthropic            (read-only pill)
 *   Auth Token                 [ ••••• ] [👁]
 *   Base URL                   [ https://... ]      (editable)
 *
 *   ── 3. MODELS (primary) ──────────────────────
 *   ⓘ 0 enabled                 [↗ 拉取模型列表] [清空]
 *   ✓ claude-sonnet-4-6            200K  1M    [✕]
 *   + 添加模型…  + 添加自定义模型 id…
 *
 *   ── 4. ADVANCED (collapsed) ──────────────────
 *   ▸ 高级选项 (role mapping, env vars, title model)
 *
 *   ── 5. FOOTER (sticky, separated) ────────────
 *                                  [取消] [测试连接] [保存]
 *
 * Design rules:
 * - All dropdowns render through antd `Select` (Portal-based)
 *   so they are never clipped by ancestor overflow / sticky
 *   footers / scroll containers.
 * - Read-only values render as a muted value pill, NOT an
 *   input — so the user cannot mistake them for editable
 *   fields.
 * - Editable fields use `SettingsInputRow` / `SettingsSelectRow`
 *   so each row is `label + description on the left, control
 *   on the right`.
 * - Dividers between rows are subtle (`divide-border/30`-style)
 *   so the page reads as a list, not as a stack of cards.
 * - The footer is sticky at the bottom of the scroll
 *   container and has a faint top border so it never
 *   occludes the last row.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Select } from 'antd';
import {
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
  PlusIcon,
  XIcon,
  CheckIcon,
  InfoIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { PresetIcon } from '@/components/settings/PresetIcon';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsSelect,
  SettingsSelectRow,
  SettingsInputRow,
} from '@/components/settings/ui';
import { useApiKeyState } from '@/components/settings/forms/hooks/useApiKeyState';
import { useBaseUrlState } from '@/components/settings/forms/hooks/useBaseUrlState';
import { useModelSelection } from '@/components/settings/forms/hooks/useModelSelection';
import { usePresetDraft } from '@/components/settings/forms/hooks/usePresetDraft';
import { useProviderModels } from '@/components/providers/hooks/useProviderModels';
import { useProvidersQuery } from '@/lib/providers/hooks/useProvidersQuery';
import { useProviderEditSave } from '@/lib/providers/hooks/useProviderEditSave';
import { isMaskedKey } from '@/lib/providers/secret';
import { getPreset, findPresetByBaseUrl, type QuickPreset } from '@/lib/provider-presets';
import { useConversationStore } from '@/stores/conversation-store';
import { cn } from '@/lib/utils';
import {
  testProviderIPC,
  listModelCapabilitiesIPC,
  type FetchedModel,
} from '@/lib/ipc-client';

const CONTEXT_PRESETS: Array<{ value: number; label: string }> = [
  { value: 200_000, label: '200K' },
  { value: 1_000_000, label: '1M' },
];

function groupByVendor(models: FetchedModel[]): Record<string, FetchedModel[]> {
  const out: Record<string, FetchedModel[]> = {};
  for (const m of models) {
    const vendor = m.ownedBy || 'Other';
    if (!out[vendor]) out[vendor] = [];
    out[vendor].push(m);
  }
  return out;
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
    if (!editProvider) return [];
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
  }, [editProvider]);

  const initialCustom = useMemo(() => {
    if (!editProvider) return [];
    try {
      const opts =
        typeof editProvider.options === 'string'
          ? JSON.parse(editProvider.options || '{}')
          : editProvider.options || {};
      return (opts as { custom_models?: string[] }).custom_models || [];
    } catch {
      return [];
    }
  }, [editProvider]);

  // Plan 205 fix-up: per-model context windows are stored in a
  // separate capability table (not in `options_json`), so the
  // edit form has to fetch them explicitly when the user lands
  // on the page. The hook then uses this map to seed its
  // internal state so the 1M/200K buttons reflect the
  // previously-saved value.
  const [initialContextWindows, setInitialContextWindows] = useState<
    Record<string, number>
  >({});

  // Hydrate `initialContextWindows` from the capability table
  // when the user opens the edit page. Best-effort: a transient
  // IPC failure means the buttons start un-set, but the user
  // can still pick 1M/200K and the change will be persisted on
  // the next click (see `useProviderModels.setContextWindow`).
  useEffect(() => {
    const providerId = editProvider?.id;
    if (!providerId) {
      setInitialContextWindows({});
      return;
    }
    let cancelled = false;
    void listModelCapabilitiesIPC({ providerId })
      .then((caps) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const c of caps) {
          if (typeof c.contextWindow === 'number' && c.contextWindow > 0) {
            next[c.modelId] = c.contextWindow;
          }
        }
        setInitialContextWindows(next);
      })
      .catch(() => {
        if (cancelled) return;
        setInitialContextWindows({});
      });
    return () => {
      cancelled = true;
    };
  }, [editProvider?.id]);

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
    initialCustomModels: initialCustom,
    initialContextWindows,
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

  const handleAddCustom = () => {
    // No-op helper — kept for legacy references if any. The
    // active path is `handleAddCustomSubmit` below, which
    // reads the free-text input by id and pushes through
    // `models.addCustom()`.
  };

  const handleAddCustomSubmit = () => {
    const el = document.getElementById(
      'provider-edit-add-custom-input',
    ) as HTMLInputElement | null;
    const id = el?.value.trim() || '';
    if (!id) return;
    if (models.addCustom(id)) {
      if (el) el.value = '';
    }
  };

  const handleRemoveModel = (modelId: string) => {
    models.disable(modelId);
    models.removeCustom(modelId);
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
    if (models.customModels.length > 0) {
      optionsJson.custom_models = models.customModels;
    }
    const optionsJsonString =
      Object.keys(optionsJson).length > 0 ? JSON.stringify(optionsJson) : undefined;

    const apiKeyArg: string | undefined =
      apiKeyState.keyState === 'replaced'
        ? apiKeyState.apiKey
        : apiKeyState.keyState === 'cleared'
          ? ''
          : undefined;

    try {
      await save(
        {
          name: presetDraft.draftLlmProvider?.name?.trim() || preset.name,
          provider_type: preset.provider_type,
          protocol: preset.protocol,
          base_url: baseUrlState.baseUrl.trim() || preset.baseUrl,
          api_key: apiKeyArg,
          // Preserve the existing on-disk env vars so we
          // don't accidentally wipe them on save. The UI no
          // longer exposes them (the Advanced section is
          // gone), but the field still exists on the disk
          // schema and may carry preset defaults like
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
  const grouped = groupByVendor(models.fetched);
  const availableCount = models.fetched.filter(
    (m) => !enabledSet.has(m.id),
  ).length;
  const vendors = Object.keys(grouped).sort();

  // Ant `Select` options for the "Add model" picker. We list every
  // fetched model that isn't already enabled, grouped by vendor.
  const modelSelectOptions: Array<{ value: string; label: string }> = [];
  for (const vendor of vendors) {
    const list = grouped[vendor].filter((m) => !enabledSet.has(m.id));
    for (const m of list) {
      modelSelectOptions.push({
        value: m.id,
        label: m.id,
      });
    }
  }

  // Plan 209 / add-mode: stable id derived from preset.key so
  // we never silently overwrite an entry created via the
  // onboarding flow that already uses the same id.
  const vendorId = isEdit ? editProvider!.id : preset.key;

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
          <button
            type="button"
            onClick={handleBack}
            data-testid="provider-edit-back"
            className="shrink-0 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeftIcon size={16} />
            <span className="hidden sm:inline">{t('common.back')}</span>
          </button>
          <h1 className="text-lg font-semibold truncate">
            {isEdit ? t('provider.edit') : t('provider.connect')}{' '}
            {preset.name}
          </h1>
        </div>
        {isEdit && (
          <button
            type="button"
            onClick={handleDelete}
            data-testid="provider-edit-delete"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 text-sm transition-colors"
          >
            <TrashIcon size={14} />
            <span className="hidden sm:inline">{t('provider.delete')}</span>
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── 1. IDENTITY ─────────────────────────────── */}
        <SettingsSection
          title={t('provider.section.identity')}
          description={t('provider.section.identityDesc')}
          icon={
            <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
              <PresetIcon iconKey={preset.iconKey} size={16} />
            </div>
          }
        >
          <SettingsCard divided>
            {/* Read-only vendor id (mono pill) */}
            <SettingsRow
              label={t('provider.vendorId')}
              description={t('provider.vendorIdReadonly')}
            >
              <span
                data-testid="provider-edit-vendor-id"
                className="font-mono text-sm text-muted-foreground bg-muted/40 px-2.5 py-1 rounded select-all"
              >
                {vendorId}
              </span>
            </SettingsRow>

            {/* Display name — editable */}
            <SettingsInputRow
              label={t('provider.displayName')}
              value={presetDraft.draftLlmProvider?.name || ''}
              onChange={(v) => presetDraft.setName(v)}
              placeholder={preset.name}
            />

            {/* Notes (专用名称) — always editable, sits in
                the Identity section so the user can label
                multiple accounts of the same vendor. */}
            <SettingsInputRow
              label={t('provider.notes')}
              value={notes}
              onChange={setNotes}
              placeholder={t('provider.notesPlaceholder')}
            />
          </SettingsCard>
        </SettingsSection>

        {/* ── 2. CONNECTION ────────────────────────────── */}
        <SettingsSection
          title={t('provider.section.connection')}
          description={t('provider.section.connectionDesc')}
          icon={
            <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
              <CircleNotchIcon size={16} />
            </div>
          }
        >
          <SettingsCard divided>
            {/* Vendor website (read-only row with secondary button) */}
            {preset.meta?.docsUrl && (
              <SettingsRow label={t('provider.websiteUrl')}>
                <a
                  href={preset.meta.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                >
                  <ArrowUpRightIcon size={12} />
                  {t('common.open')}
                </a>
              </SettingsRow>
            )}

            {/* Get API Key link */}
            {preset.meta?.apiKeyUrl && (
              <SettingsRow label={t('provider.getApiKey')}>
                <a
                  href={preset.meta.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition-colors"
                >
                  <ArrowUpRightIcon size={12} />
                  {t('common.open')}
                </a>
              </SettingsRow>
            )}

            {/* API format (read-only pill) */}
            <SettingsRow
              label={t('provider.apiFormat')}
              description={t('provider.apiFormatHint')}
            >
              <span className="font-mono text-sm text-muted-foreground bg-muted/40 px-2.5 py-1 rounded">
                {preset.protocol}
              </span>
            </SettingsRow>

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

            {/* Show/Hide button — outside the input so it can
                sit in the row's right-hand area. */}
            {preset.fields.includes('api_key') && (
              <div className="px-4 py-2 flex justify-end border-t border-border/30">
                <button
                  type="button"
                  onClick={() => setApiKeyRevealed((v) => !v)}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  {apiKeyRevealed ? (
                    <EyeSlashIcon size={12} />
                  ) : (
                    <EyeIcon size={12} />
                  )}
                  {apiKeyRevealed ? t('provider.hideKey') : t('provider.showKey')}
                </button>
              </div>
            )}

            {/* Base URL */}
            {preset.fields.includes('base_url') && (
              <SettingsInputRow
                label={t('provider.baseUrl')}
                value={baseUrlState.baseUrl}
                onChange={(v) => baseUrlState.setBaseUrl(v)}
                placeholder={preset.baseUrl}
              />
            )}
          </SettingsCard>
        </SettingsSection>

        {/* ── 3. MODELS (primary) ──────────────────────── */}
        <SettingsSection
          title={t('provider.section.models')}
          description={t('provider.section.modelsDesc')}
          icon={
            <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground">
              <CheckIcon size={16} />
            </div>
          }
          action={
            <div className="flex items-center gap-1.5">
              {models.enabled.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded"
                >
                  <XIcon size={12} />
                  {t('provider.clearAll')}
                </button>
              )}
              <button
                type="button"
                onClick={() => models.fetch()}
                disabled={models.isFetching}
                data-testid="provider-edit-fetch-models"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border/40 bg-surface/60 text-xs hover:text-foreground hover:border-accent/50 disabled:opacity-50"
              >
                {models.isFetching ? (
                  <SpinnerGapIcon size={12} className="animate-spin" />
                ) : (
                  <ArrowUpRightIcon size={12} />
                )}
                {t('provider.modelInput.fetch')}
              </button>
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
                <InfoIcon
                  size={20}
                  className="text-muted-foreground/60"
                />
                <p className="text-sm text-muted-foreground">
                  {t('provider.modelInput.noEnabledHint')}
                </p>
                <button
                  type="button"
                  onClick={() => models.fetch()}
                  disabled={models.isFetching}
                  className="text-xs text-accent hover:underline inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {models.isFetching ? (
                    <SpinnerGapIcon size={12} className="animate-spin" />
                  ) : (
                    <ArrowUpRightIcon size={12} />
                  )}
                  {t('provider.modelInput.fetch')}
                </button>
              </div>
            ) : (
              <ul
                data-testid="provider-edit-enabled-list"
                className="divide-y divide-border/20"
              >
                {models.enabled.map((modelId) => {
                  const isCustom = models.customModels.includes(modelId);
                  const ctx = models.contextWindows.get(modelId) ?? null;
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
                        <div className="text-sm font-mono truncate">
                          {modelId}
                        </div>
                        {isCustom && (
                          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                            {t('provider.custom')}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        {CONTEXT_PRESETS.map((presetCtx) => {
                          const active = ctx === presetCtx.value;
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
                      <button
                        type="button"
                        onClick={() => handleRemoveModel(modelId)}
                        data-testid={`provider-edit-remove-${modelId}`}
                        className="shrink-0 p-1 rounded text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10"
                        aria-label={t('provider.remove')}
                      >
                        <XIcon size={12} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Add model — antd Select (Portal-based, cannot be clipped) */}
            <div className="px-4 py-3 border-t border-border/30 space-y-2">
              {models.fetched.length > 0 ? (
                <Select
                  showSearch
                  allowClear={false}
                  value={null}
                  placeholder={
                    availableCount > 0
                      ? `${t('provider.addModel')}…`
                      : t('provider.modelInput.noMatch')
                  }
                  disabled={availableCount === 0}
                  onChange={(v) => {
                    if (typeof v === 'string') {
                      handleAddFromList(v);
                    }
                  }}
                  // The Portal-based dropdown escapes any
                  // overflow:hidden / sticky-footer ancestor and
                  // renders at the body level.
                  className="w-full settings-select-antd"
                  classNames={{ popup: { root: 'settings-select-dropdown' } }}
                  // Width matches the trigger.
                  popupMatchSelectWidth
                  // Filter on user-typed query.
                  filterOption={(input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                  options={modelSelectOptions}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => models.fetch()}
                  disabled={models.isFetching}
                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-dashed border-border/40 text-xs text-muted-foreground hover:text-foreground hover:border-accent/50 disabled:opacity-50"
                >
                  {models.isFetching ? (
                    <SpinnerGapIcon size={12} className="animate-spin" />
                  ) : (
                    <PlusIcon size={12} />
                  )}
                  {t('provider.fetchFirstHint')}
                </button>
              )}

              {/* Custom model id — direct inline input */}
              <div className="flex items-center gap-2">
                <input
                  id="provider-edit-add-custom-input"
                  type="text"
                  placeholder={t('provider.customPlaceholder')}
                  data-testid="provider-edit-add-custom"
                  className="flex-1 px-3 py-1.5 rounded-md text-sm bg-surface/40 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent/50 font-mono"
                />
                <button
                  type="button"
                  onClick={handleAddCustomSubmit}
                  data-testid="provider-edit-add-custom-submit"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-50"
                >
                  <PlusIcon size={12} />
                  {t('provider.add')}
                </button>
              </div>
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
          <button
            type="button"
            onClick={handleBack}
            className="px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40"
          >
            {t('provider.cancel')}
          </button>
          <button
            type="button"
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-border/40 bg-surface/60 text-foreground hover:bg-muted/40 disabled:opacity-50"
          >
            {testing ? (
              <SpinnerGapIcon size={12} className="animate-spin" />
            ) : (
              <CircleNotchIcon size={14} />
            )}
            {testing
              ? t('settings.providers.testing')
              : t('bridge.testConnection')}
          </button>
          <button
            type="submit"
            disabled={saving}
            data-testid="provider-edit-save"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
          >
            {saving && <SpinnerGapIcon size={12} className="animate-spin" />}
            {isEdit ? t('provider.update') : t('provider.connect')}
          </button>
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
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon size={16} />
        {t('common.back')}
      </button>
      <p className="text-sm text-muted-foreground">
        {loading ? t('provider.loading') : t('provider.noProviders')}
      </p>
    </div>
  );
}

/**
 * src/components/providers/ProviderQuickConnect.tsx
 *
 * Lightweight inline panel rendered inside `ProviderPickerView`
 * when the user clicks a preset card. The @duya/ai catalog already
 * ships the model list, baseUrl, protocol, and env defaults for
 * every preset, so connecting a mainstream provider only requires
 * the API key — everything else is saved from preset defaults.
 *
 * Layout (inline page, not a modal — follows the plan 205
 * inline-page convention):
 *
 *   ← Back     [icon] DeepSeek            (configured badge)
 *              只需填写 API 密钥…
 *
 *   API Key            [ ••••• ] [获取密钥 ↗]
 *   Base URL           [ https://... ]    (only when preset requires it)
 *
 *   已预置 4 个模型
 *   [deepseek-v4-pro] [deepseek-v4-flash] …
 *
 *   [高级设置]  [测试连接]  [连接]
 *
 * The full `ProviderEditView` stays available through the
 * "advanced" button for base URL overrides, model picking, and
 * compat overrides. Update mode (preset already configured)
 * shows the masked key and preserves the existing provider's
 `extraEnv` / `headers` / `notes`.
 */

import { useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { SettingsInput } from '@/components/settings/ui';
import { PresetIcon } from '@/components/settings/PresetIcon';
import { useTranslation } from '@/hooks/useTranslation';
import { useApiKeyState } from '@/components/settings/forms/hooks/useApiKeyState';
import { useProviderEditSave } from '@/lib/providers/hooks/useProviderEditSave';
import { testProviderIPC } from '@/lib/ipc-client';
import type { QuickPreset } from '@/lib/provider-presets';
import type { RendererLlmProviderDTO } from '@/lib/providers/ipc-types';
import { useOpenExternal } from '@/lib/providers/hooks/useOpenExternal';
import { cn } from '@/lib/utils';

const MAX_MODEL_CHIPS = 6;

export interface ProviderQuickConnectProps {
  preset: QuickPreset;
  /** Existing provider instance matching this preset (update mode). */
  existingProvider?: RendererLlmProviderDTO | null;
  onBack: () => void;
  /** Navigate to the full `ProviderEditView`. */
  onAdvanced: () => void;
  /** Called after a successful save — lands on the provider list. */
  onConnected: () => void;
}

export function ProviderQuickConnect({
  preset,
  existingProvider,
  onBack,
  onAdvanced,
  onConnected,
}: ProviderQuickConnectProps) {
  const { t } = useTranslation();
  const { save, isPending: saving } = useProviderEditSave();
  const openExternal = useOpenExternal();

  const isUpdate = !!existingProvider;
  const needsApiKey = preset.fields.includes('api_key');
  const needsBaseUrl = preset.fields.includes('base_url');

  const apiKeyState = useApiKeyState({
    masked: existingProvider?.apiKey || undefined,
  });
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);

  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message?: string;
    error?: string;
    suggestion?: string;
  } | null>(null);

  const defaultModelIds = useMemo(
    () => (preset.defaultModels ?? []).map((m) => m.modelId),
    [preset],
  );
  const firstModel = defaultModelIds[0] ?? '';

  const apiKeyDisplay =
    apiKeyState.keyState === 'cleared'
      ? ''
      : apiKeyState.apiKey || apiKeyState.maskedApiKey;

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (needsApiKey && !isUpdate && apiKeyState.keyState !== 'replaced') {
      setError(t('provider.apiKeyRequired'));
      return;
    }

    const apiKeyArg =
      apiKeyState.keyState === 'replaced'
        ? apiKeyState.apiKey
        : apiKeyState.keyState === 'cleared'
          ? ''
          : undefined;

    const options: Record<string, unknown> = {};
    if (defaultModelIds.length > 0) {
      options.enabled_models = defaultModelIds;
      options.defaultModel = firstModel;
    }

    try {
      await save(
        {
          name: preset.name,
          provider_type: preset.provider_type,
          protocol: preset.protocol,
          base_url: baseUrl.trim() || preset.baseUrl,
          api_key: apiKeyArg,
          extra_env:
            existingProvider?.extraEnv &&
            existingProvider.extraEnv !== '{}'
              ? existingProvider.extraEnv
              : JSON.stringify(preset.defaultEnvOverrides || {}),
          enabled_models: defaultModelIds,
          options,
          options_json:
            Object.keys(options).length > 0
              ? JSON.stringify(options)
              : undefined,
          preset_id: preset.key,
          existing_provider_dto: existingProvider
            ? {
                headers: existingProvider.headers,
                extraEnv: existingProvider.extraEnv,
                notes: existingProvider.notes,
              }
            : undefined,
        },
        existingProvider?.id ?? null,
      );
      onConnected();
    } catch (err) {
      const e2 = err as { code?: string; message?: string };
      if (e2?.code === 'masked_key') {
        setError(t('provider.maskedKeyRejected'));
      } else {
        setError(e2?.message ?? t('provider.saveFailed'));
      }
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const data = await testProviderIPC({
        provider_type: preset.provider_type,
        base_url: baseUrl.trim() || preset.baseUrl,
        // Same contract as `ProviderEditView`: when untouched we
        // forward the masked hint; the server 401s and the user
        // re-types the real key to retry.
        api_key: apiKeyState.apiKey || apiKeyState.maskedApiKey,
        auth_style: preset.authStyle,
        model: firstModel,
      });
      if (data.success) {
        setTestResult({
          success: true,
          message: data.message || t('provider.connectionSuccess'),
        });
      } else {
        setTestResult({
          success: false,
          error: data.error?.message || t('provider.connectionFailed'),
          suggestion: data.error?.suggestion,
        });
      }
    } catch {
      setTestResult({ success: false, error: t('provider.cannotConnect') });
    } finally {
      setTesting(false);
    }
  };

  const visibleModels = defaultModelIds.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = defaultModelIds.length - visibleModels.length;

  return (
    <div data-testid="provider-quick-connect" className="space-y-5 max-w-3xl">
      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          data-testid="provider-quick-connect-back"
          className="shrink-0"
        >
          <ArrowLeftIcon size={16} />
          <span className="hidden sm:inline">{t('common.back')}</span>
        </Button>
        <div className="shrink-0 w-9 h-9 rounded-lg bg-muted flex items-center justify-center">
          <PresetIcon iconKey={preset.iconKey} size={20} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold truncate">
              {preset.name}
            </h1>
            {isUpdate && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-green-500/15 text-green-700 dark:text-green-300 shrink-0">
                <CheckCircleIcon size={10} fill="currentColor" />
                {t('provider.configured')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {preset.descriptionZh}
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('provider.quickConnect.subtitle')}
      </p>

      <form onSubmit={handleConnect} className="space-y-4">
        {/* ── Credentials ── */}
        <div className="rounded-2xl border border-border/50 bg-surface/40 p-4 space-y-1">
          {needsApiKey && (
            <SettingsInput
              label={
                preset.authStyle === 'auth_token' ? 'Auth Token' : 'API Key'
              }
              description={t('provider.quickConnect.keyHint')}
              value={apiKeyDisplay}
              onChange={(v) => apiKeyState.setApiKey(v)}
              placeholder={preset.authStyle === 'auth_token' ? 'token-...' : 'sk-...'}
              type="password"
              action={
                preset.meta?.apiKeyUrl ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openExternal(preset.meta!.apiKeyUrl!)}
                    className="text-amber-600 dark:text-amber-400 shrink-0"
                  >
                    <ArrowUpRightIcon size={12} />
                    {t('provider.getApiKey')}
                  </Button>
                ) : undefined
              }
            />
          )}
          {needsBaseUrl && (
            <SettingsInput
              label={t('provider.baseUrl')}
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder={preset.baseUrl}
            />
          )}
        </div>

        {/* ── Preset model preview ── */}
        {defaultModelIds.length > 0 && (
          <div className="rounded-2xl border border-border/50 bg-surface/40 p-4 space-y-2">
            <p className="text-xs text-muted-foreground">
              {t('provider.quickConnect.modelsPreset', {
                count: defaultModelIds.length,
              })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {visibleModels.map((modelId) => (
                <span
                  key={modelId}
                  data-testid={`provider-quick-connect-model-${modelId}`}
                  className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-muted/60 text-foreground/80"
                >
                  {modelId}
                </span>
              ))}
              {hiddenCount > 0 && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-muted/60 text-muted-foreground">
                  +{hiddenCount}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Inline status ── */}
        {testResult && (
          <div
            data-testid="provider-quick-connect-test-result"
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
            data-testid="provider-quick-connect-error"
            className="rounded-md px-3 py-2 text-sm bg-destructive/10 text-destructive"
          >
            {error}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAdvanced}
            data-testid="provider-quick-connect-advanced"
          >
            {t('provider.quickConnect.advanced')}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={
                testing ||
                (needsApiKey && !apiKeyState.apiKey && !apiKeyState.maskedApiKey)
              }
              data-testid="provider-quick-connect-test"
            >
              {testing ? (
                <SpinnerGapIcon size={12} className="animate-spin" />
              ) : (
                <CircleNotchIcon size={14} />
              )}
              {testing ? t('settings.providers.testing') : t('bridge.testConnection')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={saving}
              data-testid="provider-quick-connect-submit"
            >
              {saving && <SpinnerGapIcon size={12} className="animate-spin" />}
              {isUpdate ? t('provider.update') : t('provider.connect')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

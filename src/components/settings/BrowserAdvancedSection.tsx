'use client';

import { useState, useCallback } from 'react';
import {
  ChevronDownIcon,
  CookieIcon,
  TrashIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  WarningIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettings } from '@/hooks/useSettings';
import { SettingsSection, SettingsCard } from '@/components/settings/ui';

type BackendMode = 'auto' | 'extension' | 'built-in';

export function BrowserAdvancedSection() {
  const { t } = useTranslation();
  const { settings, save, saving } = useSettings();
  const [expanded, setExpanded] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ count: number; failed: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  const mode = settings.browserBackendMode ?? 'auto';

  const handleModeChange = useCallback(async (newMode: BackendMode) => {
    await save({ browserBackendMode: newMode });
  }, [save]);

  const handleImportCookies = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    try {
      const result = await window.electronAPI?.browserCookie?.importCookies('chrome');
      if (result?.ok) {
        setImportResult({ count: result.count ?? 0, failed: result.failed ?? 0 });
      } else {
        setImportError(result?.error ?? 'Unknown error');
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setImporting(false);
    }
  }, []);

  const handleClearData = useCallback(async () => {
    const confirmed = window.confirm(t('browserAdvanced.clearDataConfirm'));
    if (!confirmed) return;

    setClearing(true);
    setCleared(false);
    try {
      const result = await window.electronAPI?.browserCookie?.clearData();
      if (result?.ok) {
        setCleared(true);
      }
    } catch {
      // ignore
    } finally {
      setClearing(false);
    }
  }, [t]);

  return (
    <SettingsSection
      title={t('browserAdvanced.title')}
      className="mt-8"
      action={
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border/50 text-foreground hover:bg-muted transition-all"
        >
          <ChevronDownIcon
            size={14}
            className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      }
    >
      {expanded && (
        <div className="space-y-4">
          {/* Backend mode */}
          <SettingsCard>
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-foreground mb-3">
                {t('browserAdvanced.backendMode')}
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    checked={mode === 'auto'}
                    onChange={() => handleModeChange('auto')}
                    disabled={saving}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="text-sm text-foreground">{t('browserAdvanced.modeAuto')}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      {t('browserAdvanced.modeAutoDesc')}
                    </span>
                  </div>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    checked={mode === 'extension'}
                    onChange={() => handleModeChange('extension')}
                    disabled={saving}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground">{t('browserAdvanced.modeExtension')}</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    checked={mode === 'built-in'}
                    onChange={() => handleModeChange('built-in')}
                    disabled={saving}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground">{t('browserAdvanced.modeBuiltin')}</span>
                </label>
              </div>
            </div>
          </SettingsCard>

          {/* Cookie import */}
          <SettingsCard>
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <CookieIcon size={18} className="text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {t('browserAdvanced.cookieImport')}
                  </span>
                </div>
                <button
                  onClick={handleImportCookies}
                  disabled={importing}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50"
                >
                  {importing && <SpinnerGapIcon size={12} className="animate-spin" />}
                  {importing ? t('browserAdvanced.importing') : t('browserAdvanced.importCookies')}
                </button>
              </div>
              {importResult && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-green-500">
                  <CheckCircleIcon size={12} />
                  {t('browserAdvanced.importSuccess', {
                    count: importResult.count,
                    failed: importResult.failed,
                  })}
                </div>
              )}
              {importError && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                  <WarningIcon size={12} />
                  {t('browserAdvanced.importFailed', { error: importError })}
                </div>
              )}
            </div>
          </SettingsCard>

          {/* Clear data */}
          <SettingsCard>
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <TrashIcon size={18} className="text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {t('browserAdvanced.clearData')}
                  </span>
                </div>
                <button
                  onClick={handleClearData}
                  disabled={clearing}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition-all disabled:opacity-50"
                >
                  {clearing && <SpinnerGapIcon size={12} className="animate-spin" />}
                  {t('browserAdvanced.clearData')}
                </button>
              </div>
              {cleared && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-green-500">
                  <CheckCircleIcon size={12} />
                  {t('browserAdvanced.dataCleared')}
                </div>
              )}
            </div>
          </SettingsCard>
        </div>
      )}
    </SettingsSection>
  );
}

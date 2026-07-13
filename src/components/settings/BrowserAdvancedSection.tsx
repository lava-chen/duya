'use client';

import { useState, useCallback } from 'react';
import {
  CookieIcon,
  TrashIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  WarningIcon,
  GlobeIcon,
  FolderOpenIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettings } from '@/hooks/useSettings';
import { useBrowserExtension } from '@/hooks/useBrowserExtension';
import { SettingsSection, SettingsCard, SettingsRow } from '@/components/settings/ui';

type CookieBrowser = 'chrome' | 'edge';

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function BrowserAdvancedSection() {
  const { t } = useTranslation();
  const { settings, saving, save } = useSettings();
  const { status: extensionStatus, isInstalled: extensionInstalled, checkExtension } = useBrowserExtension({
    autoCheck: true,
    interval: 30000,
  });

  const [importing, setImporting] = useState(false);
  const [cookieBrowser, setCookieBrowser] = useState<CookieBrowser>('chrome');
  const [cookieProfile, setCookieProfile] = useState('Default');
  const [importResult, setImportResult] = useState<{ count: number; failed: number; unsupported: number; source?: 'extension' } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importErrorCode, setImportErrorCode] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [homeUrlDraft, setHomeUrlDraft] = useState(settings.browserHomeUrl ?? '');
  const [homeUrlError, setHomeUrlError] = useState<string | null>(null);

  const handleSaveHomeUrl = useCallback(async () => {
    const trimmed = homeUrlDraft.trim();
    if (!isValidHttpUrl(trimmed)) {
      setHomeUrlError(t('browserAdvanced.homeUrlInvalid'));
      return;
    }
    await save({ browserHomeUrl: trimmed });
    setHomeUrlError(null);
  }, [homeUrlDraft, save, t]);

  const handleSelectDownloadFolder = useCallback(async () => {
    const result = await window.electronAPI?.dialog?.selectDownloadFolder({
      defaultPath: settings.browserDownloadPath,
    });
    if (result && !result.canceled && result.filePaths.length > 0) {
      await save({ browserDownloadPath: result.filePaths[0] });
    }
  }, [save, settings.browserDownloadPath]);

  const handleClearDownloadFolder = useCallback(async () => {
    await save({ browserDownloadPath: '' });
  }, [save]);

  const handleImportCookies = useCallback(async () => {
    setImporting(true);
    setImportResult(null);
    setImportError(null);
    setImportErrorCode(null);
    try {
      const result = await window.electronAPI?.browserCookie?.importCookies(cookieBrowser, cookieProfile.trim() || 'Default');
      if (result?.ok) {
        setImportResult({
          count: result.count ?? 0,
          failed: result.failed ?? 0,
          unsupported: result.unsupported ?? 0,
          source: result.source,
        });
      } else {
        setImportError(result?.error ?? 'Unknown error');
        setImportErrorCode(result?.errorCode ?? null);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setImporting(false);
    }
  }, [cookieBrowser, cookieProfile]);

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

  const handleOpenExtensions = useCallback(() => {
    window.open('chrome://extensions/', '_blank');
  }, []);

  const handleRefreshExtension = useCallback(async () => {
    await checkExtension();
  }, [checkExtension]);

  const extensionActionButtons = (
    <div className="mt-1.5 flex items-center gap-2">
      <button
        type="button"
        onClick={handleOpenExtensions}
        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface border border-border/50 text-foreground hover:bg-muted transition-all"
      >
        {t('browserAdvanced.openExtensions')}
      </button>
      <button
        type="button"
        onClick={handleRefreshExtension}
        disabled={extensionStatus === 'checking'}
        className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface border border-border/50 text-foreground hover:bg-muted transition-all disabled:opacity-50"
      >
        {t('browserAdvanced.refreshExtension')}
      </button>
    </div>
  );

  return (
    <SettingsSection
      title={t('browserAdvanced.title')}
      description={t('browserAdvanced.description')}
      className="mt-8"
    >
      <div className="space-y-4">
        {/* Home URL */}
        <SettingsCard>
          <SettingsRow
            label={
              <span className="flex items-center gap-2.5">
                <GlobeIcon size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{t('browserAdvanced.homeUrl')}</span>
              </span>
            }
          />
          <div className="px-4 pb-3.5">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={homeUrlDraft}
                onChange={(e) => {
                  setHomeUrlDraft(e.target.value);
                  setHomeUrlError(null);
                }}
                onBlur={handleSaveHomeUrl}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveHomeUrl(); }}
                placeholder="https://www.google.com"
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg border text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50 disabled:opacity-50"
              />
            </div>
            {homeUrlError && (
              <p className="mt-2 text-xs text-destructive">{homeUrlError}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t('browserAdvanced.homeUrlDesc')}</p>
          </div>
        </SettingsCard>

        {/* Download path */}
        <SettingsCard>
          <SettingsRow
            label={
              <span className="flex items-center gap-2.5">
                <FolderOpenIcon size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{t('browserAdvanced.downloadPath')}</span>
              </span>
            }
            action={
              <div className="flex items-center gap-2">
                {settings.browserDownloadPath && (
                  <button
                    onClick={handleClearDownloadFolder}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-surface border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted transition-all disabled:opacity-50"
                  >
                    {t('browserAdvanced.resetDefault')}
                  </button>
                )}
                <button
                  onClick={handleSelectDownloadFolder}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50"
                >
                  {t('browserAdvanced.change')}
                </button>
              </div>
            }
          />
          <div className="px-4 pb-3.5">
            <code className="block w-full px-3 py-2 rounded-lg text-xs font-mono truncate bg-surface border border-border/50 text-foreground">
              {settings.browserDownloadPath || t('browserAdvanced.defaultDownloadPath')}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">{t('browserAdvanced.downloadPathDesc')}</p>
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
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs text-muted-foreground">
                  {t('browserAdvanced.cookieSource')}
                  <select
                    value={cookieBrowser}
                    onChange={(event) => setCookieBrowser(event.target.value as CookieBrowser)}
                    disabled={importing}
                    className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                  >
                    <option value="chrome">Google Chrome</option>
                    <option value="edge">Microsoft Edge</option>
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">
                  {t('browserAdvanced.cookieProfile')}
                  <input
                    value={cookieProfile}
                    onChange={(event) => setCookieProfile(event.target.value)}
                    disabled={importing}
                    placeholder="Default"
                    className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                  />
                </label>
              </div>
              {!extensionInstalled && (
                <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-accent/5 border border-accent/10 text-xs text-muted-foreground">
                  <WarningIcon size={14} className="shrink-0 mt-0.5 text-accent" />
                  <div className="flex-1">
                    {t('browserAdvanced.importExtensionHint')}
                    {extensionActionButtons}
                  </div>
                </div>
              )}
              {importResult && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-green-500">
                  <CheckCircleIcon size={12} />
                  {t('browserAdvanced.importSuccess', {
                    count: importResult.count,
                    failed: importResult.failed + importResult.unsupported,
                  })}
                  {importResult.source === 'extension' && ` ${t('browserAdvanced.importLiveSource')}`}
                </div>
              )}
              {(importError || importErrorCode) && (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                  <WarningIcon size={12} className="shrink-0 mt-0.5" />
                  <div className="flex-1">
                    {importErrorCode === 'COOKIE_DATABASE_BUSY' && (
                      <>
                        {t('browserAdvanced.importSourceBusy', {
                          browser: cookieBrowser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge',
                        })}
                        {!extensionInstalled && extensionActionButtons}
                      </>
                    )}
                    {importErrorCode === 'APP_BOUND_EXTENSION_UNAVAILABLE' && (
                      <>
                        {t('browserAdvanced.importAppBoundUnavailable')}
                        {extensionActionButtons}
                      </>
                    )}
                    {!importErrorCode && t('browserAdvanced.importFailed', { error: importError ?? 'Unknown error' })}
                  </div>
                </div>
              )}
              {importResult && importResult.unsupported > 0 && (
                <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
                  <WarningIcon size={12} className="shrink-0 mt-0.5" />
                  <div className="flex-1">
                    {t('browserAdvanced.importUnsupported', { count: importResult.unsupported })}
                    {!extensionInstalled && extensionActionButtons}
                  </div>
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
    </SettingsSection>
  );
}

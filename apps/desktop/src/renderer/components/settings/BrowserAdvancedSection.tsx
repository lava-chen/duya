'use client';

import { useState, useCallback } from 'react';
import {
  CookieIcon,
  TrashIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  GlobeIcon,
  FolderOpenIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettings } from '@/hooks/useSettings';
import { SettingsSection, SettingsCard, SettingsRow } from '@/components/settings/ui';
import { Button } from '@/components/ui/Button';
import { ImportCookiesDialog } from './ImportCookiesDialog';

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

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [homeUrlDraft, setHomeUrlDraft] = useState(settings.browserHomeUrl ?? '');
  const [homeUrlError, setHomeUrlError] = useState<string | null>(null);
  const [maxTabsDraft, setMaxTabsDraft] = useState(String(settings.browserMaxTabs ?? 10));
  const [maxTabsError, setMaxTabsError] = useState<string | null>(null);

  const handleSaveHomeUrl = useCallback(async () => {
    const trimmed = homeUrlDraft.trim();
    if (!isValidHttpUrl(trimmed)) {
      setHomeUrlError(t('browserAdvanced.homeUrlInvalid'));
      return;
    }
    await save({ browserHomeUrl: trimmed });
    setHomeUrlError(null);
  }, [homeUrlDraft, save, t]);

  const handleSaveMaxTabs = useCallback(async () => {
    const parsed = Number(maxTabsDraft);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      setMaxTabsError(t('browserAdvanced.maxTabsInvalid'));
      return;
    }
    const value = Math.floor(parsed);
    setMaxTabsDraft(String(value));
    setMaxTabsError(null);
    await save({ browserMaxTabs: value });
  }, [maxTabsDraft, save, t]);

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
          <div className="pb-3.5">
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

        {/* Max agent pages */}
        <SettingsCard>
          <SettingsRow
            label={
              <span className="flex items-center gap-2.5">
                <GlobeIcon size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{t('browserAdvanced.maxTabs')}</span>
              </span>
            }
          />
          <div className="pb-3.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={100}
                value={maxTabsDraft}
                onChange={(e) => {
                  setMaxTabsDraft(e.target.value);
                  setMaxTabsError(null);
                }}
                onBlur={handleSaveMaxTabs}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveMaxTabs(); }}
                disabled={saving}
                className="flex-1 px-3 py-2 rounded-lg border text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50 disabled:opacity-50"
              />
            </div>
            {maxTabsError && (
              <p className="mt-2 text-xs text-destructive">{maxTabsError}</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t('browserAdvanced.maxTabsDesc')}</p>
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearDownloadFolder}
                    disabled={saving}
                  >
                    {t('browserAdvanced.resetDefault')}
                  </Button>
                )}
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSelectDownloadFolder}
                  disabled={saving}
                >
                  {t('browserAdvanced.change')}
                </Button>
              </div>
            }
          />
          <div className="pb-3.5">
            <code className="block w-full px-3 py-2 rounded-lg text-xs font-mono truncate bg-surface border border-border/50 text-foreground">
              {settings.browserDownloadPath || t('browserAdvanced.defaultDownloadPath')}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">{t('browserAdvanced.downloadPathDesc')}</p>
          </div>
        </SettingsCard>

        {/* Cookie import */}
        <SettingsCard>
          <div className="py-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <CookieIcon size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {t('browserAdvanced.cookieImport')}
                </span>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
              >
                {t('browserImport.title')}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('browserImport.description')}</p>
          </div>
        </SettingsCard>

        <ImportCookiesDialog
          isOpen={importDialogOpen}
          onClose={() => setImportDialogOpen(false)}
        />

        {/* Clear data */}
        <SettingsCard>
          <div className="py-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <TrashIcon size={18} className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">
                  {t('browserAdvanced.clearData')}
                </span>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearData}
                disabled={clearing}
              >
                {clearing && <SpinnerGapIcon size={12} className="animate-spin" />}
                {t('browserAdvanced.clearData')}
              </Button>
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

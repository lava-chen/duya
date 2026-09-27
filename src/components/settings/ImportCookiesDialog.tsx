'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  ClockIcon,
  CookieIcon,
  GlobeIcon,
  KeyIcon,
  SpinnerGapIcon,
  WarningIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBrowserExtension } from '@/hooks/useBrowserExtension';
import { Modal } from '@/components/ui/page';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import type { BrowserCookieProfile } from '../../../electron/preload';

type CookieBrowser = 'chrome' | 'edge';

interface ImportResult {
  count: number;
  failed: number;
  unsupported: number;
  source?: 'extension';
}

interface ImportCookiesDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Import-from-browser dialog, mirroring the agentic-browser reference:
 * detected browser profiles with display names, a data-type checklist and a
 * platform-specific hint. Only cookies are imported today; the password and
 * history rows render as "coming soon" to set expectations (plan 573
 * phases 3-4).
 */
export function ImportCookiesDialog({ isOpen, onClose }: ImportCookiesDialogProps) {
  const { t } = useTranslation();
  const { status: extensionStatus, isInstalled: extensionInstalled, checkExtension } = useBrowserExtension({
    autoCheck: true,
    interval: 30000,
  });

  const [browser, setBrowser] = useState<CookieBrowser>('chrome');
  const [profiles, setProfiles] = useState<BrowserCookieProfile[]>([]);
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importErrorCode, setImportErrorCode] = useState<string | null>(null);

  const detectProfiles = useCallback(async (target: CookieBrowser) => {
    setDetecting(true);
    setDetectError(null);
    try {
      const response = await window.electronAPI?.browserCookie?.detectProfiles(target);
      if (response?.ok && response.profiles) {
        setProfiles(response.profiles);
        const preferred = response.profiles.find((p) => p.cookieDbExists) ?? response.profiles[0];
        setSelectedDir((current) => {
          const stillThere = response.profiles?.some((p) => p.dir === current && p.browser === target);
          return stillThere ? current : (preferred?.dir ?? '');
        });
      } else {
        setProfiles([]);
        setSelectedDir('');
        setDetectError(response?.error ?? 'Unknown error');
      }
    } catch (err) {
      setProfiles([]);
      setSelectedDir('');
      setDetectError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setResult(null);
      setImportError(null);
      setImportErrorCode(null);
      void detectProfiles(browser);
    }
  }, [isOpen, browser, detectProfiles]);

  const handleImport = useCallback(async () => {
    if (!selectedDir) return;
    setImporting(true);
    setResult(null);
    setImportError(null);
    setImportErrorCode(null);
    try {
      const response = await window.electronAPI?.browserCookie?.importCookies(browser, selectedDir);
      if (response?.ok) {
        setResult({
          count: response.count ?? 0,
          failed: response.failed ?? 0,
          unsupported: response.unsupported ?? 0,
          source: response.source,
        });
      } else {
        setImportError(response?.error ?? 'Unknown error');
        setImportErrorCode(response?.errorCode ?? null);
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setImporting(false);
    }
  }, [browser, selectedDir]);

  const extensionHintButtons = (
    <div className="mt-1.5 flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => window.open('chrome://extensions/', '_blank')}
      >
        {t('browserAdvanced.openExtensions')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void checkExtension()}
        disabled={extensionStatus === 'checking'}
      >
        {t('browserAdvanced.refreshExtension')}
      </Button>
    </div>
  );

  const platformHint = (() => {
    const ua = navigator.userAgent;
    if (ua.includes('Mac')) return t('browserAdvanced.macosKeychainHint');
    if (ua.includes('Win')) return t('browserImport.winHint');
    return t('browserAdvanced.cookiePlatformUnsupported');
  })();

  const selectedProfile = profiles.find((p) => p.dir === selectedDir);

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('browserImport.title')}
      subtitle={t('browserImport.description')}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} variant="ghost" size="md">
            {t('browserImport.cancel')}
          </Button>
          <Button
            onClick={handleImport}
            variant="primary"
            size="md"
            disabled={importing || !selectedDir || !selectedProfile?.cookieDbExists}
          >
            {importing && <SpinnerGapIcon size={14} className="animate-spin" />}
            {importing ? t('browserAdvanced.importing') : t('browserImport.import')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Source browser + profile */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-sm text-muted-foreground">{t('browserImport.from')}</span>
          <select
            value={browser}
            onChange={(event) => setBrowser(event.target.value as CookieBrowser)}
            disabled={detecting || importing}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground"
          >
            <option value="chrome">Google Chrome</option>
            <option value="edge">Microsoft Edge</option>
          </select>
          <select
            value={selectedDir}
            onChange={(event) => setSelectedDir(event.target.value)}
            disabled={detecting || importing || profiles.length === 0}
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground disabled:opacity-50"
          >
            {profiles.length === 0 && (
              <option value="">{t('browserImport.profilePlaceholder')}</option>
            )}
            {profiles.map((profile) => (
              <option key={profile.dir} value={profile.dir} disabled={!profile.cookieDbExists}>
                {profile.name === profile.dir ? profile.name : `${profile.name} (${profile.dir})`}
                {!profile.cookieDbExists && ` — ${t('browserImport.noData')}`}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="md"
            onClick={() => void detectProfiles(browser)}
            disabled={detecting || importing}
            aria-label={t('browserImport.refresh')}
            title={t('browserImport.refresh')}
          >
            <ArrowsClockwiseIcon size={14} className={detecting ? 'animate-spin' : ''} />
          </Button>
        </div>
        {detectError && (
          <p className="text-xs text-destructive">
            {t('browserImport.detectError', { error: detectError })}
          </p>
        )}
        {!detectError && !detecting && profiles.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('browserImport.noProfiles')}</p>
        )}

        {/* Data checklist */}
        <div className="rounded-xl border border-border/50 bg-surface px-4 py-1">
          <div className="flex items-center justify-between py-3">
            <span className="flex items-center gap-2.5 text-sm font-medium text-foreground">
              <CookieIcon size={18} className="text-muted-foreground" />
              {t('browserImport.cookie')}
            </span>
            <Switch checked onCheckedChange={() => {}} disabled ariaLabel={t('browserImport.cookie')} />
          </div>
          <div className="flex items-center justify-between border-t border-border/40 py-3">
            <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <KeyIcon size={18} className="text-muted-foreground" />
              {t('browserImport.passwords')}
            </span>
            <span className="text-xs text-muted-foreground">{t('browserImport.comingSoon')}</span>
          </div>
          <div className="flex items-center justify-between border-t border-border/40 py-3">
            <span className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <ClockIcon size={18} className="text-muted-foreground" />
              {t('browserImport.history')}
            </span>
            <span className="text-xs text-muted-foreground">{t('browserImport.comingSoon')}</span>
          </div>
        </div>

        {/* Platform hint */}
        <div className="flex items-start gap-2 rounded-lg bg-accent/5 border border-accent/10 p-3 text-xs text-muted-foreground">
          <GlobeIcon size={14} className="shrink-0 mt-0.5 text-accent" />
          <div className="flex-1">{platformHint}</div>
        </div>

        {/* Import outcome */}
        {result && (
          <div className="flex items-start gap-1.5 text-xs text-green-500">
            <CheckCircleIcon size={12} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              {t('browserAdvanced.importSuccess', {
                count: result.count,
                failed: result.failed + result.unsupported,
              })}
              {result.source === 'extension' && ` ${t('browserAdvanced.importLiveSource')}`}
            </div>
          </div>
        )}
        {result && result.unsupported > 0 && (
          <div className="flex items-start gap-1.5 text-xs text-amber-500">
            <WarningIcon size={12} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              {t('browserAdvanced.importUnsupported', { count: result.unsupported })}
              {!extensionInstalled && extensionHintButtons}
            </div>
          </div>
        )}
        {(importError || importErrorCode) && (
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <WarningIcon size={12} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              {importErrorCode === 'COOKIE_DATABASE_BUSY' && (
                <>
                  {t('browserAdvanced.importSourceBusy', {
                    browser: browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge',
                  })}
                  {!extensionInstalled && extensionHintButtons}
                </>
              )}
              {importErrorCode === 'APP_BOUND_EXTENSION_UNAVAILABLE' && (
                <>
                  {t('browserAdvanced.importAppBoundUnavailable')}
                  {!extensionInstalled && extensionHintButtons}
                </>
              )}
              {!importErrorCode && t('browserAdvanced.importFailed', { error: importError ?? 'Unknown error' })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

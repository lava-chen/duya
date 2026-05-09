'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  ChromeIcon,
  CheckCircleIcon,
  CopyIcon,
  ExternalLinkIcon,
  WarningIcon,
  PlugIcon,
  InfoIcon,
  SpinnerGapIcon,
  ArrowsClockwiseIcon,
  PlusIcon,
  XIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBrowserExtension } from '@/hooks/useBrowserExtension';
import { useSettings } from '@/hooks/useSettings';
import { SettingsSection, SettingsCard, SettingsRow } from '@/components/settings/ui';

const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

function isValidDomainInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed);
      return DOMAIN_PATTERN.test(url.hostname);
    } catch {
      return false;
    }
  }
  return DOMAIN_PATTERN.test(trimmed);
}

export default function BrowserExtensionSection() {
  const { t } = useTranslation();
  const { settings, loading: settingsLoading, saving, save } = useSettings();
  const { status, health, isInstalled, checkExtension, lastChecked } = useBrowserExtension({
    autoCheck: true,
    interval: 30000,
  });
  const [copied, setCopied] = useState(false);

  // Browser Security state
  const [blockedDomains, setBlockedDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (settings.blockedDomains) {
      setBlockedDomains(settings.blockedDomains);
      setIsDirty(false);
      setDomainError(null);
    }
  }, [settings.blockedDomains]);

  const handleAddDomain = useCallback(() => {
    if (!newDomain.trim()) return;
    if (!isValidDomainInput(newDomain)) {
      setDomainError(t('settings.security.invalidDomain'));
      return;
    }
    const normalized = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (blockedDomains.includes(normalized)) {
      setDomainError(t('settings.security.domainAlreadyExists'));
      return;
    }
    setBlockedDomains(prev => [...prev, normalized]);
    setNewDomain("");
    setDomainError(null);
    setIsDirty(true);
  }, [newDomain, blockedDomains, t]);

  const handleRemoveDomain = useCallback((domain: string) => {
    setBlockedDomains(prev => prev.filter(d => d !== domain));
    setIsDirty(true);
  }, []);

  const handleSaveDomains = useCallback(async () => {
    await save({ blockedDomains });
    setIsDirty(false);
  }, [blockedDomains, save]);

  const handleOpenExtensions = () => {
    window.open('chrome://extensions/', '_blank');
  };

  const handleCopyPath = useCallback(() => {
    const path = '<DUYA_INSTALL_DIR>/extension/';
    navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const getStatusConfig = () => {
    switch (status) {
      case 'checking':
        return {
          icon: <SpinnerGapIcon size={20} className="animate-spin" />,
          text: t('browserExtension.checking'),
          subtext: t('browserExtension.statusDesc'),
          color: 'text-muted-foreground',
          bgColor: 'bg-muted',
          borderColor: 'border-border/50',
          dotColor: 'bg-muted-foreground',
          glow: '',
        };
      case 'connected':
        return {
          icon: <PlugIcon size={20} />,
          text: t('browserExtension.connected'),
          subtext: t('browserExtension.statusDesc'),
          color: 'text-green-500',
          bgColor: 'bg-green-500/10',
          borderColor: 'border-green-500/30',
          dotColor: 'bg-green-500',
          glow: 'shadow-[0_0_20px_rgba(34,197,94,0.15)]',
        };
      case 'disconnected':
        return {
          icon: <PlugIcon size={20} />,
          text: t('browserExtension.notInstalled'),
          subtext: t('browserExtension.statusDesc'),
          color: 'text-yellow-500',
          bgColor: 'bg-yellow-500/10',
          borderColor: 'border-yellow-500/30',
          dotColor: 'bg-yellow-500',
          glow: '',
        };
      case 'error':
        return {
          icon: <WarningIcon size={20} />,
          text: t('browserExtension.error'),
          subtext: t('browserExtension.statusDesc'),
          color: 'text-destructive',
          bgColor: 'bg-destructive/10',
          borderColor: 'border-destructive/30',
          dotColor: 'bg-destructive',
          glow: '',
        };
      default:
        return {
          icon: <SpinnerGapIcon size={20} className="animate-spin" />,
          text: t('browserExtension.checking'),
          subtext: t('browserExtension.statusDesc'),
          color: 'text-muted-foreground',
          bgColor: 'bg-muted',
          borderColor: 'border-border/50',
          dotColor: 'bg-muted-foreground',
          glow: '',
        };
    }
  };

  const statusConfig = getStatusConfig();

  return (
    <div className="settings-section">
      {/* Hero Status Card */}
      <SettingsCard
        className={`mb-6 overflow-hidden transition-all duration-500 ${statusConfig.glow} ${
          isInstalled ? 'border-green-500/20' : 'border-border/50'
        }`}
      >
        <div className="p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center ${statusConfig.bgColor} ${statusConfig.color} border ${statusConfig.borderColor} transition-all duration-300`}
              >
                {statusConfig.icon}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`w-2 h-2 rounded-full ${statusConfig.dotColor} ${status === 'checking' ? 'animate-pulse' : ''}`} />
                  <span className="text-[15px] font-semibold tracking-tight text-foreground">
                    {statusConfig.text}
                  </span>
                </div>
                <span className="text-xs leading-relaxed text-muted-foreground">{statusConfig.subtext}</span>
              </div>
            </div>
            <button
              onClick={checkExtension}
              disabled={status === 'checking'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-surface border border-border/50 text-foreground hover:bg-muted transition-all disabled:opacity-50"
              title={t('browserExtension.refresh')}
            >
              <ArrowsClockwiseIcon size={14} className={status === 'checking' ? 'animate-spin' : ''} />
              <span>{t('browserExtension.refresh')}</span>
            </button>
          </div>
          {lastChecked && (
            <div className="mt-3 text-[11px] font-mono text-muted-foreground">
              {t('browserExtension.lastChecked')}: {lastChecked.toLocaleTimeString()}
            </div>
          )}
        </div>
      </SettingsCard>

      {/* Connected State - Connection Details Only */}
      {isInstalled && health && (
        <SettingsSection title={t('browserExtension.connectionDetails')}>
          <SettingsCard>
            {[
              { label: t('browserExtension.daemon'), value: health.daemonRunning ? t('browserExtension.daemonRunning') : t('browserExtension.daemonStopped'), ok: health.daemonRunning },
              { label: t('browserExtension.extension'), value: health.extensionConnected ? t('browserExtension.extensionConnected') : t('browserExtension.extensionDisconnected'), ok: health.extensionConnected },
              { label: t('browserExtension.port'), value: String(health.port), ok: true },
              { label: t('browserExtension.pending'), value: String(health.pendingCommands), ok: health.pendingCommands === 0 },
              ...(health.extensionVersion ? [{ label: t('browserExtension.version'), value: health.extensionVersion, ok: true }] : []),
            ].map((item, idx) => (
              <SettingsRow
                key={idx}
                label={<span className="text-sm text-muted-foreground">{item.label}</span>}
              >
                <span className="text-sm font-medium flex items-center gap-1.5 text-foreground">
                  <span className={`w-1.5 h-1.5 rounded-full ${item.ok ? 'bg-green-500' : 'bg-destructive'}`} />
                  {item.value}
                </span>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      )}

      {/* Installation Guide */}
      {!isInstalled && (
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-4 rounded-xl bg-surface/50 border border-border/50">
            <InfoIcon size={16} className="shrink-0 mt-0.5 text-accent" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t('browserExtension.installDesc')}
            </p>
          </div>

          <SettingsSection title={t('browserExtension.steps')}>
            <SettingsCard>
              {[
                t('browserExtension.step1'),
                t('browserExtension.step2'),
                t('browserExtension.step3'),
              ].map((step, idx) => (
                <div key={idx} className="flex items-start gap-3 px-4 py-3">
                  <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold bg-accent/10 text-accent shrink-0">
                    {idx + 1}
                  </div>
                  <span className="text-sm leading-relaxed text-foreground pt-0.5">{step}</span>
                </div>
              ))}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title={t('browserExtension.extensionPath')}>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-4 py-3 rounded-lg text-xs font-mono truncate bg-surface border border-border/50 text-foreground">
                {'<DUYA_INSTALL_DIR>/extension/'}
              </code>
              <button
                onClick={handleCopyPath}
                className="p-3 rounded-lg bg-surface border border-border/50 hover:bg-muted transition-all"
                title={t('common.copy')}
              >
                {copied ? <CheckCircleIcon size={16} className="text-green-500" /> : <CopyIcon size={16} className="text-muted-foreground" />}
              </button>
            </div>
          </SettingsSection>

          <button
            onClick={handleOpenExtensions}
            className="w-full flex items-center justify-center gap-2.5 px-6 py-3 rounded-xl text-sm font-semibold text-white bg-accent hover:bg-accent/90 transition-all shadow-lg shadow-accent/20"
          >
            <ChromeIcon size={18} />
            {t('browserExtension.openChrome')}
            <ExternalLinkIcon size={14} />
          </button>
        </div>
      )}

      {/* Browser Security Section */}
      <SettingsSection
        title={t('settings.security.browserSecurityTitle')}
        description={t('settings.security.browserSecurityDescription')}
        className="mt-8"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3.5">
            <div className="flex items-center gap-2 mb-3">
              <input
                type="text"
                value={newDomain}
                onChange={(e) => { setNewDomain(e.target.value); setDomainError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddDomain(); }}
                placeholder={t('settings.security.domainPlaceholder')}
                disabled={settingsLoading}
                className="flex-1 px-3 py-2 rounded-lg border text-sm bg-surface text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent border-border/50 disabled:opacity-50"
              />
              <button
                onClick={handleAddDomain}
                disabled={settingsLoading}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50"
              >
                <PlusIcon size={14} />
                {t('settings.security.addDomain')}
              </button>
            </div>
            {domainError && (
              <p className="text-xs text-destructive mb-2">{domainError}</p>
            )}
            {blockedDomains.length > 0 ? (
              <div className="space-y-1.5">
                {blockedDomains.map((domain) => (
                  <div
                    key={domain}
                    className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface border border-border/50 text-sm text-foreground"
                  >
                    <span className="font-mono text-xs">{domain}</span>
                    <button
                      onClick={() => handleRemoveDomain(domain)}
                      disabled={settingsLoading}
                      className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all disabled:opacity-50"
                      title={t('settings.security.removeDomain')}
                    >
                      <XIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-2">
                {t('settings.security.noBlockedDomains')}
              </p>
            )}
          </div>
        </SettingsCard>

        {isDirty && (
          <div className="mt-4 flex items-center justify-end gap-3">
            <span className="text-xs text-muted-foreground">{t('settings.security.unsavedChanges')}</span>
            <button
              onClick={handleSaveDomains}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 transition-all disabled:opacity-50"
            >
              {saving && <SpinnerGapIcon size={14} className="animate-spin" />}
              {saving ? t('settings.security.saving') : t('settings.security.saveChanges')}
            </button>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

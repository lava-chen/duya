'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  GlobeIcon,
  ChromeIcon,
  CheckCircleIcon,
  CopyIcon,
  ExternalLinkIcon,
  InfoIcon,
  SpinnerGapIcon,
  ArrowsClockwiseIcon,
  PlusIcon,
  XIcon,
  FolderOpenIcon,
  ChevronDownIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import { useBrowserExtension } from '@/hooks/useBrowserExtension';
import { useSettings } from '@/hooks/useSettings';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsSelectRow,
} from '@/components/settings/ui';
import { ExtensionConfirmDialog } from '@/components/ExtensionConfirmDialog';
import { BrowserAdvancedSection } from './BrowserAdvancedSection';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';

// Chrome Web Store extension URL
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/duya-browser-bridge/hpkgmnimcghdnodpoehidjeinnhlnpkd';

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
  const { status, health, isInstalled, checkExtension, lastChecked, storeAvailable, checkStoreAvailability } = useBrowserExtension({
    autoCheck: true,
    interval: 30000,
  });
  const [copied, setCopied] = useState(false);
  const [showManualInstall, setShowManualInstall] = useState(false);
  const [extensionPath, setExtensionPath] = useState('');
  const [checkingStore, setCheckingStore] = useState(false);
  const [confirmingExtension, setConfirmingExtension] = useState(false);

  // Browser Security state
  const [blockedDomains, setBlockedDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const backendModeOptions = [
    { value: 'auto', label: t('browserBackend.auto'), description: t('browserBackend.autoDesc') },
    { value: 'extension', label: t('browserBackend.extension'), description: t('browserBackend.extensionTitle') },
    { value: 'built-in', label: t('browserBackend.builtin'), description: t('browserBackend.builtinDesc') },
    { value: 'human-like', label: t('browserBackend.humanLike'), description: t('browserBackend.humanLikeDesc') },
  ];

  const handleModeChange = useCallback(async (mode: string) => {
    const newMode = mode as 'auto' | 'extension' | 'built-in' | 'human-like';
    await save({ browserBackendMode: newMode });
    try {
      await window.electronAPI?.browserBackend?.updateMode(newMode);
    } catch {
      // Persisted already; the agent will pick it up on next init if live update fails.
    }
  }, [save]);

  useEffect(() => {
    if (settings.blockedDomains) {
      setBlockedDomains(settings.blockedDomains);
      setIsDirty(false);
      setDomainError(null);
    }
  }, [settings.blockedDomains]);

  useEffect(() => {
    // Check store availability on mount if extension not installed
    if (!isInstalled && storeAvailable === null && !checkingStore) {
      setCheckingStore(true);
      checkStoreAvailability().finally(() => setCheckingStore(false));
    }
    // If store is not available, show manual install by default
    if (storeAvailable === false && !showManualInstall) {
      setShowManualInstall(true);
    }
  }, [isInstalled, storeAvailable, checkStoreAvailability, checkingStore, showManualInstall]);

  useEffect(() => {
    if (showManualInstall) {
      window.electronAPI?.browserExtension?.getExtensionPath()
        .then(setExtensionPath)
        .catch(() => {});
    }
  }, [showManualInstall]);

  useEffect(() => {
    // Keep status checks responsive while disconnected so pending approval
    // prompts appear quickly without waiting for the default 30s poll.
    if (status === 'connected') return;
    const timer = setInterval(() => {
      void checkExtension();
    }, 3000);
    return () => clearInterval(timer);
  }, [status, checkExtension]);

  const handleApprovePendingExtension = useCallback(async () => {
    if (!window.electronAPI?.browserExtension?.approvePending) return;
    setConfirmingExtension(true);
    try {
      await window.electronAPI.browserExtension.approvePending();
    } finally {
      setConfirmingExtension(false);
      await checkExtension();
    }
  }, [checkExtension]);

  const handleDenyPendingExtension = useCallback(async () => {
    if (!window.electronAPI?.browserExtension?.denyPending) return;
    setConfirmingExtension(true);
    try {
      await window.electronAPI.browserExtension.denyPending();
    } finally {
      setConfirmingExtension(false);
      await checkExtension();
    }
  }, [checkExtension]);

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

  const handleOpenChromeStore = () => {
    window.open(CHROME_STORE_URL, '_blank');
  };

  const handleOpenExtensions = () => {
    window.open('chrome://extensions/', '_blank');
  };

  const handleOpenFolder = () => {
    if (extensionPath) {
      window.electronAPI?.shell?.openPath(extensionPath);
    }
  };

  const handleCopyPath = useCallback(() => {
    if (extensionPath) {
      navigator.clipboard.writeText(extensionPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [extensionPath]);

  const getStatusConfig = () => {
    switch (status) {
      case 'checking':
        return {
          text: t('browserExtension.checking'),
          color: 'text-muted-foreground',
          dotColor: 'bg-muted-foreground',
          pulse: true,
        };
      case 'connected':
        return {
          text: t('browserExtension.connected'),
          color: 'text-green-500',
          dotColor: 'bg-green-500',
          pulse: false,
        };
      case 'disconnected':
        return {
          text: t('browserExtension.notInstalled'),
          color: 'text-yellow-500',
          dotColor: 'bg-yellow-500',
          pulse: false,
        };
      case 'error':
        return {
          text: t('browserExtension.error'),
          color: 'text-destructive',
          dotColor: 'bg-destructive',
          pulse: false,
        };
      default:
        return {
          text: t('browserExtension.checking'),
          color: 'text-muted-foreground',
          dotColor: 'bg-muted-foreground',
          pulse: true,
        };
    }
  };

  const statusConfig = getStatusConfig();

  return (
    <>
      <div className="settings-section">
        {/* Page header */}
        <div className="mb-8">
          <h2 className="text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
            {t('browserExtension.pageTitle')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t('browserExtension.pageDescription')}
          </p>
        </div>

        {/* Built-in browser toggle / primary control */}
        <SettingsCard className="mb-8">
          <div className="flex items-center gap-4 py-4">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-accent/10 text-accent shrink-0">
              <GlobeIcon size={22} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {t('browserExtension.builtinBrowser')}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {t('browserExtension.builtinBrowserDesc')}
              </div>
            </div>
            <div className="shrink-0">
              <SettingsToggle
                label=""
                checked={true}
                onCheckedChange={() => {}}
                disabled={true}
              />
            </div>
          </div>
        </SettingsCard>

        {/* General: backend mode + data management */}
        <SettingsSection
          title={t('browserExtension.generalTitle')}
          description={t('browserExtension.generalDescription')}
        >
          <SettingsCard className="mb-4">
            <SettingsSelectRow
              label={t('browserBackend.label')}
              value={settings.browserBackendMode ?? 'auto'}
              onValueChange={handleModeChange}
              options={backendModeOptions}
              disabled={saving}
            />
          </SettingsCard>

          <BrowserAdvancedSection />
        </SettingsSection>

        {/* Browser Extension Section - simplified and moved to the back */}
        <SettingsSection
          title={t('browserExtension.title')}
          description={t('browserExtension.statusDesc')}
          className="mt-8"
        >
          <SettingsCard className="mb-4">
            <SettingsRow
              label={
                <span className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${statusConfig.dotColor} ${statusConfig.pulse ? 'animate-pulse' : ''}`} />
                  <span className="text-sm font-medium text-foreground">{statusConfig.text}</span>
                </span>
              }
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={checkExtension}
                  disabled={status === 'checking'}
                  title={t('browserExtension.refresh')}
                >
                  <ArrowsClockwiseIcon size={14} className={status === 'checking' ? 'animate-spin' : ''} />
                  {t('browserExtension.refresh')}
                </Button>
              }
            />
            {lastChecked && (
              <div className="pb-3 text-[11px] font-mono text-muted-foreground">
                {t('browserExtension.lastChecked')}: {lastChecked.toLocaleTimeString()}
              </div>
            )}
          </SettingsCard>

          {!isInstalled && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-surface/50 border border-border/50">
                <InfoIcon size={16} className="shrink-0 mt-0.5 text-accent" />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t('browserExtension.installDesc')}
                </p>
              </div>

              {!showManualInstall && (
                <Button
                  variant="primary"
                  size="lg"
                  onClick={handleOpenChromeStore}
                  className="w-full rounded-xl shadow-lg shadow-accent/20"
                >
                  <ChromeIcon size={18} />
                  {t('browserExtension.openChromeStore')}
                  <ExternalLinkIcon size={14} />
                </Button>
              )}

              {showManualInstall && (
                <>
                  <SettingsSection title={t('browserExtension.extensionPath')}>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-4 py-3 rounded-lg text-xs font-mono truncate bg-surface border border-border/50 text-foreground">
                        {extensionPath || '<DUYA_INSTALL_DIR>/extension/'}
                      </code>
                      <IconButton
                        variant="default"
                        size="md"
                        aria-label={t('common.copy')}
                        title={t('common.copy')}
                        onClick={handleCopyPath}
                        disabled={!extensionPath}
                      >
                        {copied ? <CheckCircleIcon size={16} className="text-green-500" /> : <CopyIcon size={16} className="text-muted-foreground" />}
                      </IconButton>
                      <IconButton
                        variant="default"
                        size="md"
                        aria-label="Open folder"
                        title="Open folder"
                        onClick={handleOpenFolder}
                        disabled={!extensionPath}
                      >
                        <FolderOpenIcon size={16} className="text-muted-foreground" />
                      </IconButton>
                    </div>
                  </SettingsSection>

                  <Button
                    variant="primary"
                    size="lg"
                    onClick={handleOpenExtensions}
                    className="w-full rounded-xl shadow-lg shadow-accent/20"
                  >
                    <ChromeIcon size={18} />
                    {t('browserExtension.openChrome')}
                    <ExternalLinkIcon size={14} />
                  </Button>
                </>
              )}

              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowManualInstall(!showManualInstall)}
                className="w-full"
                style={{
                  color: 'var(--muted)',
                  backgroundColor: 'var(--surface)',
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.backgroundColor = 'var(--surface)')
                }
              >
                <ChevronDownIcon
                  size={14}
                  className={`transition-transform duration-200 ${showManualInstall ? 'rotate-180' : ''}`}
                />
                {showManualInstall
                  ? (t('browserExtension.useStoreInstall'))
                  : (t('browserExtension.useManualInstall'))}
              </Button>
            </div>
          )}
        </SettingsSection>

        {/* Browser Security Section */}
        <SettingsSection
          title={t('settings.security.browserSecurityTitle')}
          description={t('settings.security.browserSecurityDescription')}
          className="mt-8"
        >
          <SettingsCard divided={false}>
            <div className="py-3.5">
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
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddDomain}
                  disabled={settingsLoading}
                >
                  <PlusIcon size={14} />
                  {t('settings.security.addDomain')}
                </Button>
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
                      <IconButton
                        variant="danger"
                        size="sm"
                        aria-label={t('settings.security.removeDomain')}
                        title={t('settings.security.removeDomain')}
                        onClick={() => handleRemoveDomain(domain)}
                        disabled={settingsLoading}
                      >
                        <XIcon size={14} />
                      </IconButton>
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
              <Button
                variant="primary"
                onClick={handleSaveDomains}
                disabled={saving}
              >
                {saving && <SpinnerGapIcon size={14} className="animate-spin" />}
                {saving ? t('settings.security.saving') : t('settings.security.saveChanges')}
              </Button>
            </div>
          )}
        </SettingsSection>
      </div>

      <ExtensionConfirmDialog
        isOpen={Boolean(health?.pendingExtensionApproval) && !confirmingExtension}
        extName={health?.pendingExtensionApproval?.extensionName ?? 'Unknown Extension'}
        extId={health?.pendingExtensionApproval?.extensionId ?? 'unknown'}
        version={health?.pendingExtensionApproval?.extensionVersion ?? null}
        onApprove={() => { void handleApprovePendingExtension(); }}
        onDeny={() => { void handleDenyPendingExtension(); }}
      />
    </>
  );
}

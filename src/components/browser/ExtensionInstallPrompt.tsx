// ExtensionInstallPrompt.tsx - Browser Extension installation guide

'use client';

import React, { useState, useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { 
  XIcon, 
  ChromeIcon, 
  ArrowRightIcon, 
  CheckIcon, 
  CopyIcon, 
  FolderOpenIcon,
  ExternalLinkIcon,
  ChevronDownIcon,
} from '@/components/icons';

// Chrome Web Store extension URL
const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/duya-browser-bridge/hpkgmnimcghdnodpoehidjeinnhlnpkd';

interface ExtensionInstallPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onDontShowAgain?: () => void;
}

type InstallStep = {
  number: number;
  title: string;
  description: string;
};

/**
 * ExtensionInstallPrompt - Guides users to install DUYA Browser Bridge extension
 * Supports both Chrome Web Store (recommended) and manual installation
 */
export function ExtensionInstallPrompt({
  isOpen,
  onClose,
  onDontShowAgain,
}: ExtensionInstallPromptProps) {
  const { t } = useTranslation();
  const [showManualInstall, setShowManualInstall] = useState(false);
  const [extensionPath, setExtensionPath] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setShowManualInstall(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && showManualInstall) {
      window.electronAPI?.browserExtension?.getExtensionPath()
        .then(setExtensionPath)
        .catch(() => {});
    }
  }, [isOpen, showManualInstall]);

  if (!isOpen) return null;

  const storeInstallSteps: InstallStep[] = [
    {
      number: 1,
      title: t('extensionInstall.storeStep1Title') || 'Go to Chrome Web Store',
      description: t('extensionInstall.storeStep1Desc') || 'Click the button below to open the Chrome Web Store',
    },
    {
      number: 2,
      title: t('extensionInstall.storeStep2Title') || 'Add to Chrome',
      description: t('extensionInstall.storeStep2Desc') || 'Click "Add to Chrome" button on the store page',
    },
    {
      number: 3,
      title: t('extensionInstall.storeStep3Title') || 'Confirm Installation',
      description: t('extensionInstall.storeStep3Desc') || 'Click "Add extension" in the popup to complete installation',
    },
  ];

  const manualInstallSteps: InstallStep[] = [
    {
      number: 1,
      title: t('extensionInstall.step1Title') || 'Open Chrome Extensions',
      description: t('extensionInstall.step1Desc') || 'Navigate to chrome://extensions/ in your Chrome browser',
    },
    {
      number: 2,
      title: t('extensionInstall.step2Title') || 'Enable Developer Mode',
      description: t('extensionInstall.step2Desc') || 'Toggle "Developer mode" switch in the top right corner',
    },
    {
      number: 3,
      title: t('extensionInstall.step3Title') || 'Load Unpacked Extension',
      description: t('extensionInstall.step3Desc') || 'Click "Load unpacked" and select the extension folder',
    },
  ];

  const installSteps = showManualInstall ? manualInstallSteps : storeInstallSteps;

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

  const handleCopyPath = async () => {
    if (extensionPath) {
      await navigator.clipboard.writeText(extensionPath);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden"
        style={{
          backgroundColor: 'var(--background)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: 'rgba(94, 109, 255, 0.1)' }}
            >
              <ChromeIcon size={20} style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
                {t('extensionInstall.title') || 'Install Browser Extension'}
              </h3>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {t('extensionInstall.subtitle') || 'Enable full browser automation capabilities'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--muted)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = 'transparent')
            }
          >
            <XIcon size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-5">
          {/* Feature highlights */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div
              className="p-3 rounded-xl"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
                  {t('extensionInstall.feature1') || 'JavaScript Execution'}
                </span>
              </div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                {t('extensionInstall.feature1Desc') || 'Interact with dynamic web apps'}
              </p>
            </div>
            <div
              className="p-3 rounded-xl"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
                  {t('extensionInstall.feature2') || 'Login Session'}
                </span>
              </div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                {t('extensionInstall.feature2Desc') || 'Use your existing browser cookies'}
              </p>
            </div>
            <div
              className="p-3 rounded-xl"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
                  {t('extensionInstall.feature3') || 'Screenshots'}
                </span>
              </div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                {t('extensionInstall.feature3Desc') || 'Capture full page images'}
              </p>
            </div>
            <div
              className="p-3 rounded-xl"
              style={{ backgroundColor: 'var(--surface)' }}
            >
              <div className="flex items-center gap-2 mb-1">
                <CheckIcon size={14} style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
                  {t('extensionInstall.feature4') || 'Interactive Control'}
                </span>
              </div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>
                {t('extensionInstall.feature4Desc') || 'Click, type, scroll on pages'}
              </p>
            </div>
          </div>

          {/* Installation steps */}
          <div className="mb-6">
            <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--text)' }}>
              {showManualInstall 
                ? (t('extensionInstall.manualStepsTitle') || 'Manual Installation Steps')
                : (t('extensionInstall.stepsTitle') || 'Installation Steps')
              }
            </h4>
            <div className="space-y-2">
              {installSteps.map((step) => (
                <div
                  key={step.number}
                  className="flex items-start gap-3 p-3 rounded-xl"
                  style={{
                    backgroundColor: 'var(--surface)',
                    border: '1px solid transparent',
                  }}
                >
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                    style={{
                      backgroundColor: 'var(--accent)',
                      color: '#fff',
                    }}
                  >
                    {step.number}
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--text)' }}>
                      {step.title}
                    </p>
                    <p className="text-[11px]" style={{ color: 'var(--muted)' }}>
                      {step.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Chrome Web Store Button - Primary */}
          {!showManualInstall && (
            <button
              onClick={handleOpenChromeStore}
              className="w-full flex items-center justify-center gap-2.5 px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 mb-4"
              style={{ background: 'linear-gradient(140deg, #5f71ff, #7286ff)' }}
            >
              <ChromeIcon size={18} />
              {t('extensionInstall.openChromeStore') || 'Install from Chrome Web Store'}
              <ExternalLinkIcon size={14} />
            </button>
          )}

          {/* Manual Install Section */}
          {showManualInstall && (
            <>
              {/* Extension path info */}
              <div
                className="p-3 rounded-xl mb-4"
                style={{ backgroundColor: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}
              >
                <p className="text-[11px] mb-1" style={{ color: 'var(--muted)' }}>
                  {t('extensionInstall.extensionPath') || 'Extension folder location:'}
                </p>
                <div className="flex items-center gap-2">
                  <code
                    className="text-[11px] font-mono px-2 py-1 rounded flex-1 truncate"
                    style={{ backgroundColor: 'var(--surface)', color: 'var(--text)' }}
                  >
                    {extensionPath || '...'}
                  </code>
                  <button
                    onClick={handleCopyPath}
                    className="shrink-0 p-1.5 rounded-lg transition-colors"
                    style={{ color: copyFeedback ? 'var(--accent)' : 'var(--muted)' }}
                    title={copyFeedback ? 'Copied!' : 'Copy path'}
                  >
                    <CopyIcon size={14} />
                  </button>
                  <button
                    onClick={handleOpenFolder}
                    className="shrink-0 p-1.5 rounded-lg transition-colors"
                    style={{ color: 'var(--muted)' }}
                    title="Open folder"
                  >
                    <FolderOpenIcon size={14} />
                  </button>
                </div>
                {copyFeedback && (
                  <p className="text-[10px] mt-1" style={{ color: 'var(--accent)' }}>
                    Copied!
                  </p>
                )}
              </div>

              <button
                onClick={handleOpenExtensions}
                className="w-full flex items-center justify-center gap-2.5 px-6 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 mb-4"
                style={{ background: 'linear-gradient(140deg, #5f71ff, #7286ff)' }}
              >
                <ChromeIcon size={18} />
                {t('extensionInstall.openChrome') || 'Open Chrome Extensions'}
                <ArrowRightIcon size={14} />
              </button>
            </>
          )}

          {/* Toggle between store and manual install */}
          <button
            onClick={() => setShowManualInstall(!showManualInstall)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs transition-colors"
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
              style={{ 
                transform: showManualInstall ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s'
              }} 
            />
            {showManualInstall 
              ? (t('extensionInstall.useStoreInstall') || 'Install from Chrome Web Store instead')
              : (t('extensionInstall.useManualInstall') || 'Can\'t access store? Use manual install')
            }
          </button>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-6 py-4 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2">
            {onDontShowAgain && (
              <button
                onClick={onDontShowAgain}
                className="text-[11px] transition-colors hover:opacity-80"
                style={{ color: 'var(--muted)' }}
              >
                {t('extensionInstall.dontShowAgain') || 'Don\'t show again'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs transition-colors"
              style={{ color: 'var(--muted)' }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = 'var(--surface-hover)')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = 'transparent')
              }
            >
              {t('common.later') || 'Later'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact banner for inline display in chat or tool results
 */
interface ExtensionBannerProps {
  onInstall: () => void;
  onDismiss?: () => void;
}

export function ExtensionBanner({ onInstall, onDismiss }: ExtensionBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-3 p-3 rounded-xl mb-3"
      style={{
        backgroundColor: 'rgba(94, 109, 255, 0.08)',
        border: '1px solid rgba(94, 109, 255, 0.2)',
      }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'rgba(94, 109, 255, 0.15)' }}
      >
        <ChromeIcon size={16} style={{ color: 'var(--accent)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: 'var(--text)' }}>
          {t('extensionInstall.bannerTitle') || 'Browser Extension Not Installed'}
        </p>
        <p className="text-[11px] truncate" style={{ color: 'var(--muted)' }}>
          {t('extensionInstall.bannerDesc') || 'Install to enable screenshots, JS execution, and interactive features'}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--muted)' }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = 'rgba(94, 109, 255, 0.1)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = 'transparent')
            }
          >
            <XIcon size={14} />
          </button>
        )}
        <button
          onClick={onInstall}
          className="px-3 py-1.5 rounded-lg text-xs transition-colors hover:opacity-90"
          style={{
            backgroundColor: 'var(--accent)',
            color: '#fff',
          }}
        >
          {t('extensionInstall.install') || 'Install'}
        </button>
      </div>
    </div>
  );
}

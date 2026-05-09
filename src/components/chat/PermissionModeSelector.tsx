// PermissionModeSelector.tsx - Simplified two-mode permission toggle
// Design reference: CodePilot ChatPermissionSelector

'use client';

import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

export type PermissionMode = 'ask' | 'bypass';

interface PermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

export function PermissionModeSelector({ value, onChange, disabled = false }: PermissionModeSelectorProps) {
  const { t } = useTranslation();
  const [showWarning, setShowWarning] = useState(false);
  const [pendingMode, setPendingMode] = useState<PermissionMode | null>(null);

  const isBypass = value === 'bypass';

  const handleToggle = () => {
    const nextMode = isBypass ? 'ask' : 'bypass';
    if (nextMode === 'bypass') {
      setPendingMode('bypass');
      setShowWarning(true);
      return;
    }
    onChange(nextMode);
  };

  const confirmBypass = () => {
    if (pendingMode) {
      onChange(pendingMode);
    }
    setShowWarning(false);
    setPendingMode(null);
  };

  const cancelBypass = () => {
    setShowWarning(false);
    setPendingMode(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        className={`
          flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition-all text-xs font-medium
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${isBypass
            ? 'bg-status-error-muted text-status-error-foreground border border-status-error-foreground/30'
            : 'text-muted-foreground border border-border/60 hover:text-foreground hover:border-foreground/30 hover:bg-accent/50'
          }
        `}
        title={isBypass ? t('permissionMode.bypassTooltip') : t('permissionMode.askTooltip')}
      >
        {isBypass ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            <line x1="12" y1="16" x2="12" y2="20" />
          </svg>
        )}
        <span>{isBypass ? t('permissionMode.bypass') : t('permissionMode.ask')}</span>
      </button>

      {/* Warning Dialog for Bypass Mode */}
      {showWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            className="rounded-lg p-5 max-w-sm mx-4 space-y-4"
            style={{
              backgroundColor: 'var(--sidebar-bg)',
              border: '1px solid var(--border)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            }}
          >
            <div className="space-y-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {t('permissionMode.bypassWarningTitle')}
              </h3>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
                {t('permissionMode.bypassWarningDesc')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={cancelBypass}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                style={{
                  backgroundColor: 'var(--surface)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmBypass}
                className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors text-white"
                style={{ backgroundColor: 'var(--status-error)' }}
              >
                {t('permissionMode.bypassConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

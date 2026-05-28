import React from 'react';
import type { PluginError } from '../../../lib/plugin-error-types';
import type { PluginErrorSeverity } from '../../../lib/plugin-error-types';

interface PluginErrorBannerProps {
  error: PluginError;
  severity?: PluginErrorSeverity;
  humanMessage?: string;
  suggestedAction?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

const SEVERITY_STYLES: Record<PluginErrorSeverity, { bg: string; border: string; text: string; badge: string }> = {
  critical: {
    bg: 'var(--bg-error-subtle, #fef2f2)',
    border: 'var(--border-error, #fca5a5)',
    text: 'var(--text-error, #991b1b)',
    badge: 'var(--badge-error, #dc2626)',
  },
  warning: {
    bg: 'var(--bg-warning-subtle, #fffbeb)',
    border: 'var(--border-warning, #fcd34d)',
    text: 'var(--text-warning, #92400e)',
    badge: 'var(--badge-warning, #d97706)',
  },
  info: {
    bg: 'var(--bg-info-subtle, #eff6ff)',
    border: 'var(--border-info, #93c5fd)',
    text: 'var(--text-info, #1e40af)',
    badge: 'var(--badge-info, #2563eb)',
  },
};

export function PluginErrorBanner({
  error,
  severity: severityOverride,
  humanMessage,
  suggestedAction,
  onAction,
  onDismiss,
}: PluginErrorBannerProps) {
  const styles = SEVERITY_STYLES[severityOverride ?? 'critical'];

  return (
    <div
      style={{
        background: styles.bg,
        border: `1px solid ${styles.border}`,
        borderRadius: '8px',
        padding: '12px 16px',
        marginBottom: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              background: styles.badge,
              color: '#fff',
              fontSize: '11px',
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: '12px',
              textTransform: 'uppercase',
            }}
          >
            {error.type}
          </span>
          <span style={{ color: styles.text, fontSize: '14px', fontWeight: 500 }}>
            {humanMessage ?? error.type}
          </span>
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: styles.text,
              opacity: 0.6,
              fontSize: '16px',
              padding: '0 4px',
            }}
          >
            x
          </button>
        )}
      </div>

      {'message' in error && (
        <div style={{ color: styles.text, fontSize: '13px', opacity: 0.85 }}>
          {(error as { message: string }).message}
        </div>
      )}

      {suggestedAction && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {onAction && (
            <button
              onClick={onAction}
              style={{
                background: styles.badge,
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Fix
            </button>
          )}
          <span style={{ color: styles.text, fontSize: '12px', opacity: 0.7 }}>
            {suggestedAction}
          </span>
        </div>
      )}
    </div>
  );
}
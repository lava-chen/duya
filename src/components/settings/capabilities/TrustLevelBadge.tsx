import React from 'react';
import type { PluginTrustLevel } from '../../../lib/plugin-security-types';

interface TrustLevelBadgeProps {
  level: PluginTrustLevel;
  verifiedBy?: string;
  showLabel?: boolean;
}

const TRUST_STYLES: Record<PluginTrustLevel, { bg: string; text: string; label: string; icon: string }> = {
  official: {
    bg: 'var(--accent, #6366f1)',
    text: '#fff',
    label: 'Official',
    icon: 'verified',
  },
  verified: {
    bg: 'var(--success, #22c55e)',
    text: '#fff',
    label: 'Verified',
    icon: 'check',
  },
  local: {
    bg: 'var(--warning, #f59e0b)',
    text: '#fff',
    label: 'Local',
    icon: 'local',
  },
  untrusted: {
    bg: 'var(--error, #ef4444)',
    text: '#fff',
    label: 'Untrusted',
    icon: 'warning',
  },
};

const ICON_MAP: Record<string, string> = {
  verified: 'V',
  check: 'C',
  local: 'L',
  warning: '!',
};

export function TrustLevelBadge({ level, verifiedBy, showLabel = true }: TrustLevelBadgeProps) {
  const style = TRUST_STYLES[level] ?? TRUST_STYLES.untrusted;

  return (
    <span
      title={verifiedBy ? `Verified by ${verifiedBy}` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        background: style.bg,
        color: style.text,
        fontSize: '11px',
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: '12px',
        lineHeight: '18px',
      }}
    >
      <span style={{ fontSize: '10px', fontWeight: 700 }}>
        {ICON_MAP[style.icon] ?? '?'}
      </span>
      {showLabel && style.label}
    </span>
  );
}
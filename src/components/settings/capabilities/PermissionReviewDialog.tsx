import React from 'react';
import type { PermissionRequest } from '../../../lib/plugin-security-types';

interface PermissionReviewDialogProps {
  pluginName: string;
  permissions: PermissionRequest[];
  onConfirm: () => void;
  onCancel: () => void;
  visible: boolean;
}

const PERMISSION_LABELS: Record<string, { label: string; description: string; icon: string }> = {
  'file-read': {
    label: 'Read Files',
    description: 'Can read files on your system',
    icon: 'F',
  },
  'file-write': {
    label: 'Write Files',
    description: 'Can create and modify files on your system',
    icon: 'F+',
  },
  'network': {
    label: 'Network Access',
    description: 'Can make network requests',
    icon: 'N',
  },
  'exec': {
    label: 'Execute Commands',
    description: 'Can run shell commands',
    icon: '>',
  },
  'agent.memory.read': {
    label: 'Read Memory',
    description: 'Can access agent memory data',
    icon: 'M',
  },
  'agent.memory.write': {
    label: 'Write Memory',
    description: 'Can modify agent memory data',
    icon: 'M+',
  },
  'workspace.read': {
    label: 'Read Workspace',
    description: 'Can read workspace files',
    icon: 'W',
  },
  'workspace.write': {
    label: 'Write Workspace',
    description: 'Can modify workspace files',
    icon: 'W+',
  },
};

function getPermissionInfo(name: string) {
  const known = PERMISSION_LABELS[name];
  if (known) return known;
  return {
    label: name,
    description: `Permission: ${name}`,
    icon: '?',
  };
}

export function PermissionReviewDialog({
  pluginName,
  permissions,
  onConfirm,
  onCancel,
  visible,
}: PermissionReviewDialogProps) {
  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--bg-surface, #fff)',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '480px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
      >
        <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
          Plugin Permissions
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', marginBottom: '16px' }}>
          <strong>{pluginName}</strong> requires the following permissions:
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
          {permissions.map((perm, index) => {
            const info = getPermissionInfo(perm.name);
            return (
              <div
                key={index}
                style={{
                  display: 'flex',
                  gap: '12px',
                  padding: '12px',
                  background: 'var(--bg-subtle, #f9fafb)',
                  borderRadius: '8px',
                  border: '1px solid var(--border, #e5e7eb)',
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '6px',
                    background: 'var(--accent, #6366f1)',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {info.icon}
                </div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 500 }}>{info.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>
                    {info.description}
                  </div>
                  {perm.scope && (
                    <div style={{ fontSize: '11px', color: 'var(--accent, #6366f1)', marginTop: '2px' }}>
                      Scope: {perm.scope}
                    </div>
                  )}
                  {perm.domains && (
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginTop: '2px' }}>
                      Domains: {perm.domains.join(', ')}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              background: 'var(--bg-subtle, #f3f4f6)',
              color: 'var(--text, #374151)',
              border: '1px solid var(--border, #d1d5db)',
              borderRadius: '8px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              background: 'var(--accent, #6366f1)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Allow & Install
          </button>
        </div>
      </div>
    </div>
  );
}
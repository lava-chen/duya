// ============================================================================
// Plugin Security Types — Shared between renderer and main process
// ============================================================================

export type PluginTrustLevel = 'official' | 'verified' | 'local' | 'untrusted';

export interface PluginTrustInfo {
  level: PluginTrustLevel;
  verifiedBy?: string;
  verifiedAt?: number;
  signature?: string;
  downgradeReason?: string;
}

export interface TrustLevelCapability {
  maxHooks: number;
  allowHttpHooks: boolean;
  allowAgentHooks: boolean;
  maxFileAccess: 'none' | 'plugin-dir-only' | 'project' | 'full';
  requirePermissionConfirmation: boolean;
  allowAutoUpdate: boolean;
}

export interface PermissionRequest {
  name: string;
  scope?: 'plugin' | 'project' | 'system';
  domains?: string[];
  paths?: string[];
}

export interface GrantedPermission extends PermissionRequest {
  grantedAt: number;
  expiresAt?: number;
  revoked: boolean;
  revokedAt?: number;
}

export interface EnterprisePolicy {
  strictKnownMarketplaces: boolean;
  allowedMarketplaces?: string[];
  blockedMarketplaces?: string[];
  blockedPlugins?: string[];
  allowedPluginSources?: string[];

  minimumTrustLevel: PluginTrustLevel;
  requireVerifiedForHooks: boolean;

  requirePermissionReview: boolean;
  autoRevokeTemporaryPermissions: boolean;
  defaultTemporaryPermissionDuration: number;

  managedPlugins: Record<
    string,
    {
      version: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }
  >;
}

export const TRUST_LEVEL_CAPABILITIES: Record<PluginTrustLevel, TrustLevelCapability> = {
  official: {
    maxHooks: Infinity,
    allowHttpHooks: true,
    allowAgentHooks: true,
    maxFileAccess: 'full',
    requirePermissionConfirmation: false,
    allowAutoUpdate: true,
  },
  verified: {
    maxHooks: 20,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'project',
    requirePermissionConfirmation: true,
    allowAutoUpdate: true,
  },
  local: {
    maxHooks: 10,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'project',
    requirePermissionConfirmation: true,
    allowAutoUpdate: false,
  },
  untrusted: {
    maxHooks: 3,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'plugin-dir-only',
    requirePermissionConfirmation: true,
    allowAutoUpdate: false,
  },
};
export enum PluginTrustLevel {
  Official = 'official',
  Verified = 'verified',
  Local = 'local',
  Untrusted = 'untrusted',
}

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

export const TRUST_LEVEL_CAPABILITIES: Record<PluginTrustLevel, TrustLevelCapability> = {
  [PluginTrustLevel.Official]: {
    maxHooks: Infinity,
    allowHttpHooks: true,
    allowAgentHooks: true,
    maxFileAccess: 'full',
    requirePermissionConfirmation: false,
    allowAutoUpdate: true,
  },
  [PluginTrustLevel.Verified]: {
    maxHooks: 20,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'project',
    requirePermissionConfirmation: true,
    allowAutoUpdate: true,
  },
  [PluginTrustLevel.Local]: {
    maxHooks: 10,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'project',
    requirePermissionConfirmation: true,
    allowAutoUpdate: false,
  },
  [PluginTrustLevel.Untrusted]: {
    maxHooks: 3,
    allowHttpHooks: false,
    allowAgentHooks: false,
    maxFileAccess: 'plugin-dir-only',
    requirePermissionConfirmation: true,
    allowAutoUpdate: false,
  },
};

export class TrustEngine {
  determineTrustLevel(
    source: string,
    marketplaceName?: string,
  ): PluginTrustInfo {
    if (source === 'bundled') {
      return { level: PluginTrustLevel.Official, verifiedBy: 'DUYA' };
    }

    // First-party plugins shipped inside the app (the builtin marketplace
    // directory). This is first-party code, not a third-party download, so it
    // sits at the same tier as `bundled`. The case was missing before plan 584,
    // which left every builtin plugin falling through to the Untrusted default.
    if (source === 'builtin-directory') {
      return { level: PluginTrustLevel.Official, verifiedBy: 'DUYA' };
    }

    if (source === 'development') {
      return { level: PluginTrustLevel.Local };
    }

    if (source === 'local') {
      return { level: PluginTrustLevel.Local };
    }

    if (source === 'marketplace' && marketplaceName) {
      return {
        level: PluginTrustLevel.Verified,
        verifiedBy: marketplaceName,
        verifiedAt: Date.now(),
      };
    }

    return { level: PluginTrustLevel.Untrusted };
  }

  getCapabilities(trust: PluginTrustInfo): TrustLevelCapability {
    // Return a copy: the table is module-level state, and plan 584 wires
    // these values into install/activation decisions. A caller that mutated
    // the returned object would silently change the policy for every later
    // caller. All fields are primitives, so a shallow copy is sufficient.
    return { ...TRUST_LEVEL_CAPABILITIES[trust.level] };
  }

  meetsMinimumLevel(
    trust: PluginTrustInfo,
    minimum: PluginTrustLevel,
  ): boolean {
    const levels: PluginTrustLevel[] = [
      PluginTrustLevel.Untrusted,
      PluginTrustLevel.Local,
      PluginTrustLevel.Verified,
      PluginTrustLevel.Official,
    ];
    return levels.indexOf(trust.level) >= levels.indexOf(minimum);
  }
}
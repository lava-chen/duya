import { PluginTrustLevel } from './trust-engine';

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

export const DEFAULT_POLICY: EnterprisePolicy = {
  strictKnownMarketplaces: false,
  minimumTrustLevel: PluginTrustLevel.Untrusted,
  requireVerifiedForHooks: false,
  requirePermissionReview: true,
  autoRevokeTemporaryPermissions: true,
  defaultTemporaryPermissionDuration: 30 * 60 * 1000,
  managedPlugins: {},
};

export class PolicyEngine {
  private policy: EnterprisePolicy;

  constructor(policy?: Partial<EnterprisePolicy>) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  getPolicy(): EnterprisePolicy {
    return { ...this.policy };
  }

  updatePolicy(patch: Partial<EnterprisePolicy>): void {
    this.policy = { ...this.policy, ...patch };
  }

  isMarketplaceAllowed(marketplaceName: string): {
    allowed: boolean;
    reason?: string;
  } {
    if (this.policy.blockedMarketplaces?.includes(marketplaceName)) {
      return {
        allowed: false,
        reason: `Marketplace "${marketplaceName}" is in the blocklist`,
      };
    }

    if (this.policy.strictKnownMarketplaces) {
      if (
        !this.policy.allowedMarketplaces ||
        !this.policy.allowedMarketplaces.includes(marketplaceName)
      ) {
        return {
          allowed: false,
          reason: `Marketplace "${marketplaceName}" is not in the allowlist`,
        };
      }
    }

    if (
      this.policy.allowedMarketplaces &&
      !this.policy.allowedMarketplaces.includes(marketplaceName)
    ) {
      return {
        allowed: false,
        reason: `Marketplace "${marketplaceName}" is not in the allowlist`,
      };
    }

    return { allowed: true };
  }

  isPluginBlocked(pluginId: string): { allowed: boolean; reason?: string } {
    if (this.policy.blockedPlugins?.includes(pluginId)) {
      return {
        allowed: false,
        reason: `Plugin "${pluginId}" is in the blocklist`,
      };
    }
    return { allowed: true };
  }

  isSourceAllowed(source: string): { allowed: boolean; reason?: string } {
    if (
      this.policy.allowedPluginSources &&
      !this.policy.allowedPluginSources.includes(source)
    ) {
      return {
        allowed: false,
        reason: `Plugin source "${source}" is not allowed by policy`,
      };
    }
    return { allowed: true };
  }

  getManagedPlugin(pluginId: string): EnterprisePolicy['managedPlugins'][string] | undefined {
    return this.policy.managedPlugins[pluginId];
  }

  isManagedPluginLocked(pluginId: string): boolean {
    return !!this.policy.managedPlugins[pluginId];
  }

  meetsMinimumTrustLevel(level: PluginTrustLevel): boolean {
    const levels: PluginTrustLevel[] = [
      PluginTrustLevel.Untrusted,
      PluginTrustLevel.Local,
      PluginTrustLevel.Verified,
      PluginTrustLevel.Official,
    ];
    return (
      levels.indexOf(level) >= levels.indexOf(this.policy.minimumTrustLevel)
    );
  }

  getTemporaryPermissionDuration(): number {
    return this.policy.defaultTemporaryPermissionDuration;
  }

  shouldAutoRevokeTemporary(): boolean {
    return this.policy.autoRevokeTemporaryPermissions;
  }
}

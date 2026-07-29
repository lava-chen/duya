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

  /**
   * Plan 312 Phase 4: App Connection providers blocked by enterprise
   * policy. When a provider id appears in this list, the
   * AppConnectionService refuses to start the OAuth flow with a
   * `provider_blocked` error. The policy schema + UI belong to Plan 92;
   * this is the runtime hook.
   */
  blockedAppConnectionProviders?: string[];
}

export const DEFAULT_POLICY: EnterprisePolicy = {
  strictKnownMarketplaces: false,
  minimumTrustLevel: PluginTrustLevel.Untrusted,
  requireVerifiedForHooks: false,
  requirePermissionReview: true,
  autoRevokeTemporaryPermissions: true,
  defaultTemporaryPermissionDuration: 30 * 60 * 1000,
  managedPlugins: {},
  blockedAppConnectionProviders: [],
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

  /**
   * Plan 312 Phase 4: check if an App Connection provider is blocked
   * by enterprise policy. Called by AppConnectionService.connect before
   * starting the OAuth flow. The policy schema + admin UI belong to
   * Plan 92; this is the runtime gate.
   */
  isProviderBlocked(providerId: string): { allowed: boolean; reason?: string } {
    if (this.policy.blockedAppConnectionProviders?.includes(providerId)) {
      return {
        allowed: false,
        reason: `App Connection provider "${providerId}" is blocked by enterprise policy`,
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

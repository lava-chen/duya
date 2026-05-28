import { getKnownMarketplacesManager } from './known-marketplaces-manager';
import type { MarketplacePolicy } from './types';

const DEFAULT_POLICY: MarketplacePolicy = {
  strictKnownMarketplaces: false,
};

export class PolicyManager {
  private policy: MarketplacePolicy;

  constructor() {
    this.policy = { ...DEFAULT_POLICY };
  }

  getPolicy(): MarketplacePolicy {
    return { ...this.policy };
  }

  updatePolicy(patch: Partial<MarketplacePolicy>): MarketplacePolicy {
    this.policy = { ...this.policy, ...patch };
    return this.getPolicy();
  }

  resetPolicy(): MarketplacePolicy {
    this.policy = { ...DEFAULT_POLICY };
    return this.getPolicy();
  }

  isMarketplaceAllowed(marketplaceKey: string): boolean {
    if (this.policy.blockedMarketplaces?.includes(marketplaceKey)) {
      return false;
    }

    if (this.policy.strictKnownMarketplaces) {
      if (this.policy.allowedMarketplaces && this.policy.allowedMarketplaces.length > 0) {
        return this.policy.allowedMarketplaces.includes(marketplaceKey);
      }
      const manager = getKnownMarketplacesManager();
      return manager.get(marketplaceKey) !== null;
    }

    return true;
  }

  isPluginBlocked(pluginName: string): boolean {
    return this.policy.blockedPlugins?.includes(pluginName) ?? false;
  }

  isSourceAllowed(sourceType: string): boolean {
    if (!this.policy.allowedPluginSources || this.policy.allowedPluginSources.length === 0) {
      return true;
    }
    return this.policy.allowedPluginSources.includes(sourceType as 'github' | 'url' | 'local');
  }
}

let policyManagerSingleton: PolicyManager | null = null;

export function getPolicyManager(): PolicyManager {
  if (!policyManagerSingleton) {
    policyManagerSingleton = new PolicyManager();
  }
  return policyManagerSingleton;
}
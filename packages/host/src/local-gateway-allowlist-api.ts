import type { HostLocalGatewayAllowlistApiV1 } from '@duya/agent-protocol/gateway-allowlist';
import type { GatewayAllowlistStore } from '@duya/data/gateway-allowlist-store';

export function createHostLocalGatewayAllowlistApi(
  store: GatewayAllowlistStore,
): HostLocalGatewayAllowlistApiV1 {
  return {
    async getGatewayAllowlist() {
      return store.get();
    },
    async isGatewayUserAllowed(platform, platformUserId) {
      return store.isAllowed(platform, platformUserId);
    },
    async addGatewayAllowlistEntry(platform, platformUserId) {
      store.add(platform, platformUserId);
    },
    async removeGatewayAllowlistEntry(platform, platformUserId) {
      store.remove(platform, platformUserId);
    },
  };
}

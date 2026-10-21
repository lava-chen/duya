import type {
  GatewayChannelDirectoryEntry,
  HostLocalGatewayDirectoryApiV1,
} from '@duya/agent-protocol/gateway-directory';
import type { GatewayChannelDirectoryStore } from '@duya/data/gateway-channel-directory-store';

export function createHostLocalGatewayDirectoryApi(
  store: GatewayChannelDirectoryStore,
): HostLocalGatewayDirectoryApiV1 {
  return {
    async listGatewayChannels(platform) {
      return store.list(platform);
    },
    async replaceGatewayChannels(platform, channels: readonly Omit<GatewayChannelDirectoryEntry, 'platform'>[]) {
      store.replace(platform, channels);
    },
  };
}

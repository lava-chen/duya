import type {
  GatewayUserMappingInput,
  HostLocalGatewayUserMapApiV1,
} from '@duya/agent-protocol/gateway-user-map';
import type { GatewayUserMapStore } from '@duya/data/gateway-user-map-store';

export function createHostLocalGatewayUserMapApi(
  store: GatewayUserMapStore,
): HostLocalGatewayUserMapApiV1 {
  return {
    async findGatewayUserMapping(platform, platformChatId) {
      return store.find(platform, platformChatId);
    },
    async findGatewayUserMappingBySession(sessionId) {
      return store.findBySessionId(sessionId);
    },
    async listGatewayUserMappings(platform) {
      return store.list(platform);
    },
    async upsertGatewayUserMapping(input: GatewayUserMappingInput) {
      store.upsert(input);
    },
  };
}

import type {
  GatewayThreadWriteInput,
  HostLocalGatewayThreadApiV1,
} from '@duya/agent-protocol/gateway-threads';
import type { GatewayThreadStore } from '@duya/data/gateway-thread-store';

export function createHostLocalGatewayThreadApi(
  store: GatewayThreadStore,
): HostLocalGatewayThreadApiV1 {
  return {
    async getGatewayThreadTitle(sessionId) {
      return store.getTitle(sessionId);
    },
    async ensureGatewayThread(input: GatewayThreadWriteInput) {
      store.ensure(input);
    },
    async resetGatewayThread(input: GatewayThreadWriteInput) {
      store.reset(input);
    },
    async setGatewayThreadTitle(input: GatewayThreadWriteInput) {
      store.setTitle(input);
    },
    async touchGatewayThread(sessionId, updatedAt) {
      store.touch(sessionId, updatedAt);
    },
  };
}

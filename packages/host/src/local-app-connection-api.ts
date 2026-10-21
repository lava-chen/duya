import type { HostLocalAppConnectionApiV1 } from '@duya/agent-protocol/app-connections';
import type { AppConnectionStore } from '@duya/data/app-connection-store';

export function createHostLocalAppConnectionApi(store: AppConnectionStore): HostLocalAppConnectionApiV1 {
  return {
    async listAppConnections() {
      return store.list();
    },
    async listAppConnectionsByProvider(provider) {
      return store.listByProvider(provider);
    },
    async getAppConnection(id) {
      return store.get(id);
    },
    async upsertAppConnection(input) {
      return store.upsert(input);
    },
    async updateAppConnectionStatus(id, status, patch) {
      return store.updateStatus(id, status, patch);
    },
    async removeAppConnection(id) {
      return store.remove(id);
    },
  };
}

import type { HostLocalModelCapabilityApiV1 } from '@duya/agent-protocol/model-capabilities';
import type { ModelCapabilityStore } from '@duya/data/model-capability-store';

export function createHostLocalModelCapabilityApi(
  store: ModelCapabilityStore,
): HostLocalModelCapabilityApiV1 {
  return {
    async getModelCapability(modelName) {
      return store.get(modelName);
    },
    async setModelCapability(input) {
      store.set(input);
      return { success: true };
    },
    async deleteModelCapability(modelName) {
      return { success: store.delete(modelName) };
    },
  };
}

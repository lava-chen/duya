import type { HostLocalProviderModelCapabilityApiV1 } from '@duya/agent-protocol/model-capabilities';
import type { ProviderModelCapabilityStore } from '@duya/data/provider-model-capability-store';

/** Host-owned persistence adapter for provider/model capability overrides. */
export function createHostLocalProviderModelCapabilityApi(
  store: ProviderModelCapabilityStore,
): HostLocalProviderModelCapabilityApiV1 {
  return {
    async listProviderModelCapabilities(providerId) {
      return store.listByProvider(providerId);
    },
    async getProviderModelCapability(providerId, modelId) {
      return store.getOne(providerId, modelId);
    },
    async upsertProviderModelCapability(capability) {
      return store.upsert({
        ...capability,
        source: capability.source === 'models-api' ? 'models-api' : 'user',
      });
    },
    async deleteProviderModelCapability(providerId, modelId) {
      return { success: store.delete(providerId, modelId) };
    },
  };
}

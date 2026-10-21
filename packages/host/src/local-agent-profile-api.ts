import type {
  AgentProfileCreateInput,
  AgentProfileUpdateInput,
  HostLocalAgentProfileApiV1,
} from '@duya/agent-protocol/agent-profiles';
import type { AgentProfileStore } from '@duya/data/agent-profile-store';

export function createHostLocalAgentProfileApi(store: AgentProfileStore): HostLocalAgentProfileApiV1 {
  return {
    async listAgentProfiles() {
      return store.list();
    },
    async getAgentProfile(id) {
      return store.get(id);
    },
    async createAgentProfile(input: AgentProfileCreateInput) {
      return store.create(input);
    },
    async updateAgentProfile(id: string, input: AgentProfileUpdateInput) {
      return store.update(id, input);
    },
    async deleteAgentProfile(id) {
      return store.delete(id);
    },
  };
}

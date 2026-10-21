import type { AgentManagementPort } from '@duya/capabilities/agent-management-tool';
import { configDb } from '../worker-db-client.js';

/** Agent identity writes stay on the existing Main-owned config IPC routes. */
export function createWorkerAgentManagementPort(): AgentManagementPort {
  return {
    async createAgent(input) {
      return await configDb.agentCreate(input) as { id: string; name: string };
    },
    async updateAgent(input) {
      return await configDb.agentUpdate(input) as { id: string; name: string };
    },
  };
}

/** Bind the capability to Host product services. */
import {
  CreateAgentTool as CapabilityCreateAgentTool,
  UpdateAgentTool as CapabilityUpdateAgentTool,
  type AgentManagementPort,
} from '@duya/capabilities/agent-management-tool';
import { createWorkerAgentManagementPort } from '@duya/host/worker-tool-services/agent-management';

export {
  CREATE_AGENT_TOOL_NAME,
  UPDATE_AGENT_TOOL_NAME,
} from '@duya/capabilities/agent-management-tool';

export class CreateAgentTool extends CapabilityCreateAgentTool {
  constructor(port: AgentManagementPort = createWorkerAgentManagementPort()) {
    super(port);
  }
}

export class UpdateAgentTool extends CapabilityUpdateAgentTool {
  constructor(port: AgentManagementPort = createWorkerAgentManagementPort()) {
    super(port);
  }
}

export const createAgentTool = new CreateAgentTool();
export const updateAgentTool = new UpdateAgentTool();

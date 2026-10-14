/** Bind the capability to Host product services. */
import {
  SendToAgentTool as CapabilitySendToAgentTool,
  type SendToAgentPort,
} from '@duya/capabilities/send-to-agent-tool';
import { createWorkerAgentMessagingPort } from '@duya/host/worker-tool-services/agent-messaging';

export type { SendToAgentPort } from '@duya/capabilities/send-to-agent-tool';

export class SendToAgentTool extends CapabilitySendToAgentTool {
  constructor(port: SendToAgentPort = createWorkerAgentMessagingPort()) {
    super(port);
  }
}

export const sendToAgentTool = new SendToAgentTool();

/** Bind the capability to Host product services. */
import {
  MessageSessionTool as CapabilityMessageSessionTool,
  type MessageSessionPort,
} from '@duya/capabilities/message-session-tool';
import { createWorkerInteragentMessagingPort } from '@duya/host/worker-tool-services/interagent-messaging';

export type {
  InteragentInvokeRequest,
  MessageSessionInvocationResult,
} from '@duya/capabilities/message-session-tool';

export class MessageSessionTool extends CapabilityMessageSessionTool {
  constructor(port: MessageSessionPort = createWorkerInteragentMessagingPort()) {
    super(port);
  }
}

export const messageSessionTool = new MessageSessionTool();

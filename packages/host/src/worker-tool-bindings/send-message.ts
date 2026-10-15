/** Compatibility adapter for the legacy Agent import path. */
import {
  SendMessageTool as CapabilitySendMessageTool,
} from '@duya/capabilities/SendMessageTool/SendMessageTool';
import type { SendMessageContext, SendMessagePort } from '@duya/capabilities/SendMessageTool/ports';
import { createWorkerSendMessagePort } from '@duya/host/worker-tool-services/send-message';

export { type SendMessageContext };

export class SendMessageTool extends CapabilitySendMessageTool {
  constructor(port: SendMessagePort = createWorkerSendMessagePort()) {
    super(port);
  }
}

export const sendMessageTool = new SendMessageTool();

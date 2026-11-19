/** Compatibility adapter for the legacy Agent import path. */
import {
  SendMessageTool as CapabilitySendMessageTool,
} from '@duya/capabilities/SendMessageTool/SendMessageTool';
import type { SendMessageContext, SendMessagePort } from '@duya/capabilities/SendMessageTool/ports';
import { randomUUID } from 'node:crypto';
import { isProjectCoordinatorProfile } from '../project/identity.js';
import { createWorkerSendMessagePort } from '@duya/host/worker-tool-services/send-message';

export { type SendMessageContext };

export class SendMessageTool extends CapabilitySendMessageTool {
  constructor(port: SendMessagePort = createWorkerSendMessagePort()) {
    super(port);
  }

  toProjectChannelTool() {
    const { channelBindingId, requestId, text, replyToInboundId } = this.input_schema.properties;
    return {
      name: this.name,
      description: 'Send a text message to an authorized Project channel. Use replyToInboundId when replying to a channel message.',
      input_schema: {
        type: 'object',
        properties: { channelBindingId, requestId, text, replyToInboundId },
        required: ['channelBindingId', 'requestId', 'text'],
        additionalProperties: false,
      },
    };
  }

  override async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: SendMessageContext,
  ) {
    if (isProjectCoordinatorProfile(context?.options?.agentProfileId)) {
      const { channelBindingId, requestId, text, replyToInboundId } = input;
      const valid = typeof channelBindingId === 'string' && channelBindingId.trim() !== ''
        && typeof requestId === 'string' && requestId.trim() !== ''
        && typeof text === 'string' && text.trim() !== ''
        && (replyToInboundId === undefined || (typeof replyToInboundId === 'string' && replyToInboundId.trim() !== ''));
      if (!valid || Object.keys(input).some((key) =>
        key !== 'channelBindingId' && key !== 'requestId' && key !== 'text' && key !== 'replyToInboundId')) {
        return {
          id: randomUUID(), name: this.name, error: true,
          result: 'invalid_request: the Project Coordinator can send only to a Project channel binding.',
        };
      }
    }
    return super.execute(input, workingDirectory, context);
  }
}

export const sendMessageTool = new SendMessageTool();

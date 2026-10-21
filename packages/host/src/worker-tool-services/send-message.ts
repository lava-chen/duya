import type {
  SendMessageChannelActivity,
  SendMessagePort,
  SendMessageRow,
} from '@duya/capabilities/SendMessageTool/ports';
import { channelDb, messageDb, sendMessageStateDb } from '../worker-db-client.js';
import { logger } from '../worker-logger.js';

/** Bind SendMessage effects to the existing Main worker DB/IPC routes. */
export function createWorkerSendMessagePort(): SendMessagePort {
  return {
    async appendMessage(sessionId: string, messages: readonly SendMessageRow[]) {
      return messageDb.append(sessionId, [...messages], null);
    },
    createWidgetPending(input) {
      return sendMessageStateDb.createWidgetPending(input);
    },
    upsertCursorAgentRun(input) {
      return sendMessageStateDb.upsertCursorAgentRun(input);
    },
    createSecretPending(input) {
      return sendMessageStateDb.createSecretPending(input);
    },
    async deliverToChannel(input) {
      return (await channelDb.deliver({
        sessionId: input.sessionId,
        channelAddress: input.channel,
        outbound: {
          content: input.content,
          ...(input.mediaUrl !== undefined ? { url: input.mediaUrl } : {}),
          ...(input.mediaAlt !== undefined ? { caption: input.mediaAlt } : {}),
        },
      })) as { success?: boolean; reason?: string } | undefined;
    },
    appendChannelActivity(input: SendMessageChannelActivity) {
      const [platform, ...chatParts] = input.channel.split(':');
      return messageDb.append(input.sessionId, [
        {
          id: input.id,
          role: 'assistant',
          content: `→ [${input.channel}] ${input.content}`,
          status: 'complete',
          msg_type: 'text',
          source: 'channel_activity',
          timestamp: Date.now(),
          metadata: {
            source: 'channel_activity',
            channelMsg: {
              direction: 'out',
              address: input.channel,
              platform: platform ?? input.channel,
              chat: chatParts.join(':'),
              text: input.content,
              ...(input.mediaUrl ? { url: input.mediaUrl } : {}),
            },
          },
        },
      ]);
    },
    logError(message, error, context, component) {
      logger.error(message, error, context, component);
    },
    logDebug(message, context) {
      logger.debug(message, context, 'SendMessageTool');
    },
  };
}

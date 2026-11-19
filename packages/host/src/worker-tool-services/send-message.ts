import type {
  SendMessageChannelActivity,
  SendMessagePort,
  SendMessageRow,
} from '@duya/capabilities/SendMessageTool/ports';
import { channelDb, messageDb, projectDb, sendMessageStateDb } from '../worker-db-client.js';
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
      })) as { success?: boolean; reason?: string; queued?: boolean; deliveryId?: string } | undefined;
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
    async sendToProjectChannel(input) {
      // The worker sends a REQUEST, not an identity: the Host resolves the
      // project, the run and the epoch from this worker attempt and decides
      // whether the binding, the reply scope and `allowProactive` permit it.
      // Nothing in this payload names a session, a run, or a Discord target.
      const result = await projectDb.tool({
        action: 'send_channel_message',
        payload: {
          requestId: input.requestId,
          channelBindingId: input.channelBindingId,
          text: input.text,
          ...(input.replyToInboundId === undefined ? {} : { replyToInboundId: input.replyToInboundId }),
        },
      }) as { ok: true; delivery?: { deliveryId: string; status: string } } | { ok: false; reason: string };

      if (!result.ok) return { ok: false, reason: result.reason };
      if (result.delivery === undefined) return { ok: false, reason: 'channel_send_failed' };
      return { ok: true, deliveryId: result.delivery.deliveryId, status: result.delivery.status };
    },
    logError(message, error, context, component) {
      logger.error(message, error, context, component);
    },
    logDebug(message, context) {
      logger.debug(message, context, 'SendMessageTool');
    },
  };
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendMessageTool } from '../src/SendMessageTool/SendMessageTool.js';
import type {
  SendMessageChannelActivity,
  SendMessagePort,
  SendMessageRow,
} from '../src/SendMessageTool/ports.js';

const effects = {
  appendMessage: vi.fn(async (_sessionId: string, _messages: readonly SendMessageRow[]) => undefined),
  createWidgetPending: vi.fn(async (_input: Parameters<SendMessagePort['createWidgetPending']>[0]) => undefined),
  upsertCursorAgentRun: vi.fn(async (_input: Parameters<SendMessagePort['upsertCursorAgentRun']>[0]) => undefined),
  createSecretPending: vi.fn(async (_input: Parameters<SendMessagePort['createSecretPending']>[0]) => undefined),
  deliverToChannel: vi.fn(async (_input: Parameters<SendMessagePort['deliverToChannel']>[0]): ReturnType<SendMessagePort['deliverToChannel']> => ({ success: true })),
  appendChannelActivity: vi.fn(async (_input: SendMessageChannelActivity) => undefined),
  logError: vi.fn(),
  logDebug: vi.fn(),
};

const tool = new SendMessageTool(effects);
const context = {
  toolUseId: 'test',
  options: { sessionId: 'bot:test:abc', agentProfileId: 'test-bot' },
};

beforeEach(() => {
  vi.clearAllMocks();
  effects.deliverToChannel.mockResolvedValue({ success: true });
});

describe('SendMessage validation and message persistence', () => {
  it('reports a durable queued receipt without claiming delivery or writing a delivered marker', async () => {
    effects.deliverToChannel.mockResolvedValueOnce({ success: true, queued: true, deliveryId: 'receipt-1' });
    const result = await tool.execute({ type: 'text', content: 'reply', channel: 'telegram:123' }, undefined, context);
    expect(result.error).not.toBe(true);
    expect(result.result).toContain('Delivery is pending; receipt: receipt-1');
    expect(result.result).not.toContain('Message delivered');
    expect(effects.appendChannelActivity).not.toHaveBeenCalled();
  });
  it('rejects cross-type fields with recovery instructions', async () => {
    const result = await tool.execute({ type: 'text', content: 'hi', widget: { prompt: 'x' } }, undefined, context);
    expect(result.error).toBe(true);
    expect(result.result).toContain('widget is only valid with type:widget');
    expect(result.result).toContain('Nothing was sent');
    expect(result.result).toContain('Re-send as separate SendMessage calls');
    expect(effects.appendMessage).not.toHaveBeenCalled();
  });

  it('rejects images on non-text types and channel on cards', async () => {
    const imageResult = await tool.execute({
      type: 'attachment', url: 'file:///C:/tmp/a.png', images: [{ url: 'file:///C:/tmp/b.png' }],
    }, undefined, context);
    expect(imageResult.result).toContain('images can only be set for type:text');

    const channelResult = await tool.execute({
      type: 'widget', widget: { prompt: 'go?', options: [{ label: 'Yes' }] }, channel: 'slack:C1',
    }, undefined, context);
    expect(channelResult.result).toContain('channel can only be set for type:text or type:attachment');
  });

  it('validates required text, attachment, image, widget, and secret fields', async () => {
    const cases = [
      [{ type: 'text' }, 'content is required when type is text'],
      [{ type: 'attachment', url: 'http://example.com/a.png' }, 'url must include a file:// or https:// scheme'],
      [{ type: 'text', content: 'look', images: [{ url: 'ftp://example.com/a.png' }] }, 'each images url must include a file:// or https:// scheme'],
      [{ type: 'widget', widget: { prompt: 'go?' } }, 'widget.options requires 1-6 real, verified choices'],
      [{ type: 'secret-request', secret: { label: 'Token', connector: 'slack' } }, 'secret.field is required'],
    ] as const;
    for (const [input, expected] of cases) {
      const result = await tool.execute(input, undefined, context);
      expect(result.error).toBe(true);
      expect(result.result).toContain(expected);
    }
  });

  it('writes text with the send_message source and preserves attachments', async () => {
    const result = await tool.execute({
      type: 'text', content: 'hello', images: [{ url: 'file:///tmp/image.png', alt: 'plot' }], reply_to: 'm-1',
    }, undefined, context);
    expect(result.error).toBeUndefined();
    expect(result.result).toContain('Message sent to user');
    expect(effects.appendMessage).toHaveBeenCalledTimes(1);
    const [sessionId, rows] = effects.appendMessage.mock.calls[0];
    expect(sessionId).toBe('bot:test:abc');
    expect(rows[0].source).toBe('send_message');
    expect(rows[0].metadata).toMatchObject({
      source: 'send_message',
      reply_to: 'm-1',
      sendMessage: { images: [{ url: 'file:///tmp/image.png', alt: 'plot' }] },
    });
  });

  it('persists widget, cursor-agent, and secret state after appending the message', async () => {
    const widget = await tool.execute({ type: 'widget', widget: { prompt: 'Deploy?', options: [{ label: 'Yes' }] } }, undefined, context);
    expect(effects.createWidgetPending).toHaveBeenCalledWith(expect.objectContaining({
      messageId: widget.id, sessionId: 'bot:test:abc', botAgentId: 'test-bot', prompt: 'Deploy?',
    }));

    const cursor = await tool.execute({ type: 'cursor-agent', bcId: 'bc-123' }, undefined, context);
    expect(effects.upsertCursorAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      messageId: cursor.id, bcId: 'bc-123', status: 'pending',
    }));

    const secret = await tool.execute({
      type: 'secret-request', secret: { label: 'Token', connector: 'slack', field: 'bot_token' },
    }, undefined, context);
    expect(effects.createSecretPending).toHaveBeenCalledWith(expect.objectContaining({
      messageId: secret.id, label: 'Token', connector: 'slack', field: 'bot_token',
    }));
    expect(effects.appendMessage).toHaveBeenCalledTimes(3);
  });

  it('treats card-state failures as best-effort after the message is delivered', async () => {
    effects.createWidgetPending.mockRejectedValueOnce(new Error('side-state unavailable'));
    const result = await tool.execute({ type: 'widget', widget: { prompt: 'Deploy?', options: [{ label: 'Yes' }] } }, undefined, context);
    expect(result.error).toBeUndefined();
    expect(effects.appendMessage).toHaveBeenCalledTimes(1);
    expect(effects.logError).toHaveBeenCalledWith(
      'sendMessageState persist failed for type: widget',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'bot:test:abc', messageId: result.id }),
      'SendMessageTool',
    );
  });

  it('uses the external channel path and writes its activity marker only after delivery', async () => {
    const result = await tool.execute({
      type: 'text', content: 'See this', channel: 'slack:C123',
    }, undefined, context);
    expect(result.error).toBeUndefined();
    expect(effects.deliverToChannel).toHaveBeenCalledWith({
      sessionId: 'bot:test:abc', channel: 'slack:C123', content: 'See this',
      mediaUrl: undefined, mediaAlt: undefined,
    });
    expect(effects.appendChannelActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: result.id, sessionId: 'bot:test:abc', channel: 'slack:C123', content: 'See this',
    }));

    const attachment = await tool.execute({
      type: 'attachment', url: 'https://example.test/report.png', alt: 'Report', channel: 'slack:C123',
    }, undefined, context);
    expect(attachment.error).toBeUndefined();
    expect(effects.deliverToChannel).toHaveBeenLastCalledWith(expect.objectContaining({
      mediaUrl: 'https://example.test/report.png', mediaAlt: 'Report',
    }));

    effects.deliverToChannel.mockResolvedValueOnce({ success: false, reason: 'disconnected' });
    effects.appendChannelActivity.mockClear();
    const failed = await tool.execute({ type: 'text', content: 'hello', channel: 'slack:C123' }, undefined, context);
    expect(failed.error).toBe(true);
    expect(failed.result).toContain('disconnected');
    expect(effects.appendChannelActivity).not.toHaveBeenCalled();
  });
});

/**
 * The Project Coordinator's `send_message` branch.
 *
 * Same tool name, different contract: a binding id, the text, and an optional
 * reply reference. The wording of the success reply is part of the contract —
 * `queued` and `unknown` must not be reported as delivered, or the model stops
 * retrying something that never left the Host.
 */
describe('send_message to a project channel', () => {
  const channelContext = { toolUseId: 'test', options: { sessionId: 'coordinator-1' } };

  function withProjectChannel(
    outcome: Awaited<ReturnType<NonNullable<SendMessagePort['sendToProjectChannel']>>>,
  ) {
    const sendToProjectChannel = vi.fn(async () => outcome);
    return { tool: new SendMessageTool({ ...effects, sendToProjectChannel }), sendToProjectChannel };
  }

  it('sends the narrow payload and reports a delivered message as sent', async () => {
    const { tool: channelTool, sendToProjectChannel } = withProjectChannel(
      { ok: true, deliveryId: 'delivery-1', status: 'sent' },
    );

    const result = await channelTool.execute(
      { channelBindingId: 'binding-1', text: 'status is green', requestId: 'req-1' },
      undefined,
      channelContext,
    );

    expect(result.error).toBeUndefined();
    // No legacy fields leak into the outgoing request.
    expect(sendToProjectChannel).toHaveBeenCalledWith({
      requestId: 'req-1', channelBindingId: 'binding-1', text: 'status is green',
    });
    expect(result.result).toContain('Sent');
    expect(result.result).toContain('delivery-1');
  });

  it('passes the reply reference when answering an external message', async () => {
    const { tool: channelTool, sendToProjectChannel } = withProjectChannel(
      { ok: true, deliveryId: 'delivery-2', status: 'sent' },
    );

    await channelTool.execute(
      { channelBindingId: 'binding-1', text: 'answering', requestId: 'req-2', replyToInboundId: 'inbound-9' },
      undefined,
      channelContext,
    );

    expect(sendToProjectChannel).toHaveBeenCalledWith(expect.objectContaining({ replyToInboundId: 'inbound-9' }));
  });

  it('does not call a queued send delivered', async () => {
    const { tool: channelTool } = withProjectChannel(
      { ok: true, deliveryId: 'delivery-3', status: 'queued' },
    );

    const result = await channelTool.execute(
      { channelBindingId: 'binding-1', text: 'hi', requestId: 'req-3' },
      undefined,
      channelContext,
    );

    expect(result.result).toContain('queued');
    expect(result.result).toContain('not delivered');
  });

  it('does not call an unknown outcome delivered', async () => {
    const { tool: channelTool } = withProjectChannel(
      { ok: true, deliveryId: 'delivery-4', status: 'unknown' },
    );

    const result = await channelTool.execute(
      { channelBindingId: 'binding-1', text: 'hi', requestId: 'req-4' },
      undefined,
      channelContext,
    );

    expect(result.result).toContain('unknown');
    expect(result.result).toContain('do not resend');
  });

  it('reports a domain refusal as an error with its code', async () => {
    const { tool: channelTool } = withProjectChannel({ ok: false, reason: 'proactive_not_allowed' });

    const result = await channelTool.execute(
      { channelBindingId: 'binding-1', text: 'hi', requestId: 'req-5' },
      undefined,
      channelContext,
    );

    expect(result.error).toBe(true);
    expect(result.result).toContain('proactive_not_allowed');
  });

  it('refuses the branch when the Host composed no channel support', async () => {
    // `effects` has no sendToProjectChannel: a bot session, or a Host without
    // the project channel domain. Falling through to the in-app path would post
    // the text where the model never asked for it.
    const result = await tool.execute(
      { channelBindingId: 'binding-1', text: 'hi', requestId: 'req-6' },
      undefined,
      channelContext,
    );

    expect(result.error).toBe(true);
    expect(result.result).toContain('channel_support_unavailable');
    expect(effects.appendMessage).not.toHaveBeenCalled();
    expect(effects.deliverToChannel).not.toHaveBeenCalled();
  });

  it('requires requestId and text', async () => {
    const { tool: channelTool, sendToProjectChannel } = withProjectChannel(
      { ok: true, deliveryId: 'delivery-5', status: 'sent' },
    );

    expect((await channelTool.execute({ channelBindingId: 'binding-1', text: 'hi' }, undefined, channelContext)).error).toBe(true);
    expect((await channelTool.execute({ channelBindingId: 'binding-1', requestId: 'r' }, undefined, channelContext)).error).toBe(true);
    expect(sendToProjectChannel).not.toHaveBeenCalled();
  });
});

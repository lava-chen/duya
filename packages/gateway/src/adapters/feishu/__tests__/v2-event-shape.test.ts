/**
 * v2-event-shape.test.ts — regression tests for inbound Feishu event field
 * mapping.
 *
 * The v2 `im.message.receive_v1` event payload names the message kind
 * `message_type`, while v1/legacy payloads and the send-message API use
 * `msg_type`. The channel must accept both, otherwise every v2 text message
 * is parsed as `type=unknown` and silently dropped by the msgType switch
 * (2026-09-23 regression: DMs arrived but never reached onMessage).
 */
import { describe, it, expect, vi } from 'vitest';

import { FeishuChannel } from '../index';
import type { FeishuAdapterOptions, FeishuEvent } from '../types';

function makeChannel(): { channel: FeishuChannel; onMessage: ReturnType<typeof vi.fn> } {
  const noop = async () => {};
  const onMessage = vi.fn(async () => {});
  const options: FeishuAdapterOptions = {
    config: {
      platform: 'feishu',
      credentials: {},
      options: {},
      appId: 'test-app',
      appSecret: 'test-secret',
    },
    onMessage: onMessage as unknown as FeishuAdapterOptions['onMessage'],
    onImageMessage: noop,
    onFileMessage: noop,
    onAudioMessage: noop,
    onPostMessage: noop,
    onCardAction: noop,
    onReactionAdded: noop,
    onReactionRemoved: noop,
    onMemberAdded: noop,
    onMemberRemoved: noop,
    onMessageRecalled: noop,
  };
  return { channel: new FeishuChannel(options), onMessage };
}

function v2TextEvent(messageId: string): FeishuEvent {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: messageId,
        chat_id: 'oc_test',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_sender' } },
    },
  } as unknown as FeishuEvent;
}

function legacyTextEvent(messageId: string): FeishuEvent {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        message_id: messageId,
        chat_id: 'oc_test',
        chat_type: 'p2p',
        msg_type: 'text',
        content: JSON.stringify({ text: 'legacy' }),
      },
      sender: { sender_id: { open_id: 'ou_sender' } },
    },
  } as unknown as FeishuEvent;
}

async function dispatch(channel: FeishuChannel, event: FeishuEvent): Promise<void> {
  await (channel as unknown as { _handleEvent: (e: FeishuEvent) => Promise<void> })._handleEvent(event);
}

describe('FeishuChannel inbound event field mapping', () => {
  it('routes a v2 im.message.receive_v1 text message (message_type) to onMessage', async () => {
    const { channel, onMessage } = makeChannel();
    await dispatch(channel, v2TextEvent('om_v2_1'));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0]).toBe('oc_test');
    expect(onMessage.mock.calls[0][1]).toBe('ou_sender');
    expect(onMessage.mock.calls[0][2]).toBe('hello');
  });

  it('still routes a legacy msg_type text message to onMessage', async () => {
    const { channel, onMessage } = makeChannel();
    await dispatch(channel, legacyTextEvent('om_v1_1'));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][2]).toBe('legacy');
  });
});

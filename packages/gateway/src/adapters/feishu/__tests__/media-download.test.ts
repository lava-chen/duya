/**
 * media-download.test.ts — focused tests for the FeishuChannel inbound
 * resource download (plan 507 P2.4).
 *
 * Only the download path is exercised: the channel is constructed but never
 * started, and global fetch is stubbed to serve the tenant-token and
 * message-resource endpoints. No WebSocket transport is involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FeishuChannel } from '../index';
import type { FeishuAdapterOptions, FeishuEvent } from '../types';

const MEDIA_CACHE_DIR = path.join(os.tmpdir(), 'duya-feishu-media');
const TOKEN_BODY = JSON.stringify({
  code: 0,
  msg: 'ok',
  tenant_access_token: 'test-token',
  expire: 3600,
});

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function makeChannel(
  overrides: Partial<
    Pick<FeishuAdapterOptions, 'onImageMessage' | 'onFileMessage' | 'onAudioMessage'>
  > = {},
): FeishuChannel {
  const noop = async () => {};
  const options: FeishuAdapterOptions = {
    config: {
      platform: 'feishu',
      credentials: {},
      options: {},
      appId: 'test-app',
      appSecret: 'test-secret',
    },
    onMessage: noop,
    onImageMessage: overrides.onImageMessage ?? noop,
    onFileMessage: overrides.onFileMessage ?? noop,
    onAudioMessage: overrides.onAudioMessage ?? noop,
    onPostMessage: noop,
    onCardAction: noop,
    onReactionAdded: noop,
    onReactionRemoved: noop,
    onMemberAdded: noop,
    onMemberRemoved: noop,
    onMessageRecalled: noop,
  };
  return new FeishuChannel(options);
}

function stubFetch(
  respond: (url: string) => Response,
  calls: FetchCall[] = [],
): void {
  vi.stubGlobal(
    'fetch',
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers as Record<string, string>) ?? {};
      calls.push({ url, headers });
      return respond(url);
    }) as unknown as typeof fetch,
  );
}

function tokenResponse(): Response {
  return new Response(TOKEN_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FeishuChannel.downloadMessageResource', () => {
  beforeEach(() => {
    fs.rmSync(MEDIA_CACHE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(MEDIA_CACHE_DIR, { recursive: true, force: true });
  });

  it('downloads a resource to the temp cache with the content-type extension', async () => {
    const calls: FetchCall[] = [];
    const payload = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response(payload, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }, calls);

    const channel = makeChannel();
    const result = await channel.downloadMessageResource('om_1', 'img_v2_abc', 'image', '.jpg');

    expect(result).not.toBeNull();
    expect(result!.startsWith(MEDIA_CACHE_DIR)).toBe(true);
    expect(path.extname(result!)).toBe('.jpeg');
    expect(fs.readFileSync(result!)).toEqual(payload);

    // Token request first, then the resource download with Bearer auth.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/auth/v3/tenant_access_token/internal');
    expect(calls[1].url).toContain('/im/v1/messages/om_1/resources/img_v2_abc?type=image');
    expect(calls[1].headers['Authorization']).toBe('Bearer test-token');
  });

  it('falls back to the provided extension for generic content types (audio)', async () => {
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response(Buffer.from([0x4f, 0x67, 0x67, 0x53]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });

    const channel = makeChannel();
    // Audio resources download with type=file and a .ogg fallback ext.
    const result = await channel.downloadMessageResource('om_2', 'file_v3_audio', 'file', '.ogg');

    expect(result).not.toBeNull();
    expect(path.extname(result!)).toBe('.ogg');
  });

  it('returns null on an HTTP error and writes no file', async () => {
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response('Forbidden', { status: 403 });
    });

    const channel = makeChannel();
    const result = await channel.downloadMessageResource('om_3', 'file_v3_x', 'file', '.pdf');

    expect(result).toBeNull();
    expect(fs.existsSync(MEDIA_CACHE_DIR)).toBe(false);
  });

  it('returns null when the tenant token cannot be acquired', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ code: 9999, msg: 'bad credentials' }), { status: 200 }));

    const channel = makeChannel();
    const result = await channel.downloadMessageResource('om_4', 'img_v2_x', 'image', '.jpg');

    expect(result).toBeNull();
    expect(fs.existsSync(MEDIA_CACHE_DIR)).toBe(false);
  });

  it('returns null for an empty payload', async () => {
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response(Buffer.alloc(0), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const channel = makeChannel();
    const result = await channel.downloadMessageResource('om_5', 'img_v2_empty', 'image', '.png');

    expect(result).toBeNull();
  });

  it('returns null when the payload exceeds the 25 MB guard', async () => {
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response(Buffer.alloc(25 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      });
    });

    const channel = makeChannel();
    const result = await channel.downloadMessageResource('om_6', 'file_v3_big', 'file', '.mp4');

    expect(result).toBeNull();
    expect(fs.existsSync(MEDIA_CACHE_DIR)).toBe(false);
  });
});

describe('FeishuChannel inbound media callback pass-through (plan 507 P2.4)', () => {
  beforeEach(() => {
    fs.rmSync(MEDIA_CACHE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(MEDIA_CACHE_DIR, { recursive: true, force: true });
  });

  /** A private inbound image message event (chat_type private, no filters). */
  function imageEvent(messageId: string, imageKey: string): FeishuEvent {
    return {
      header: {
        event_id: 'evt_passthrough',
        event_type: 'im.message.receive_v1',
        create_time: '0',
        token: 't',
        app_id: 'a',
        tenant_key: 'tk',
      },
      event: {
        type: 'im.message.receive_v1',
        message: {
          message_id: messageId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
          chat_id: 'oc_bot',
          chat_type: 'private',
        },
        sender: { sender_id: { open_id: 'ou_user' } },
      },
    };
  }

  it('delivers a local download path to onImageMessage', async () => {
    const onImageMessage = vi.fn(async () => {});
    const channel = makeChannel({ onImageMessage });

    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    });

    const handler = channel as unknown as { _handleEvent: (e: FeishuEvent) => Promise<void> };
    await handler._handleEvent(imageEvent('om_img', 'img_v2_pass'));

    expect(onImageMessage).toHaveBeenCalledTimes(1);
    const [chatId, userId, imageKey, messageId, localPath] = onImageMessage.mock.calls[0];
    expect(chatId).toBe('oc_bot');
    expect(userId).toBe('ou_user');
    expect(imageKey).toBe('img_v2_pass');
    expect(messageId).toBe('om_img');
    // The best-effort download was persisted in the temp cache and handed over.
    expect(typeof localPath).toBe('string');
    expect(fs.existsSync(localPath!)).toBe(true);
    expect(path.extname(localPath!)).toBe('.jpeg');
  });

  it('falls back to a placeholder (no path) when the download is skipped', async () => {
    const onImageMessage = vi.fn(async () => {});
    const channel = makeChannel({ onImageMessage });

    // Resource endpoint returns 403 so downloadMessageResource yields null.
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response('Forbidden', { status: 403 });
    });

    const handler = channel as unknown as { _handleEvent: (e: FeishuEvent) => Promise<void> };
    await handler._handleEvent(imageEvent('om_img2', 'img_v2_denied'));

    expect(onImageMessage).toHaveBeenCalledTimes(1);
    // The callback fires with localPath undefined so the connector keeps its
    // placeholder text (backward-compatible, no path breaks existing flows).
    expect(onImageMessage.mock.calls[0][4]).toBeUndefined();
  });
});

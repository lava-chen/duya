/**
 * outbound-media-upload.test.ts — tests for the FeishuChannel outbound media
 * upload path (todo #1) and the setProcessingStatus urgent_app removal
 * (todo #2).
 *
 * The channel is constructed but never started; global fetch is stubbed to
 * serve the tenant-token, upload and send endpoints. Upload request bodies
 * (FormData) are inspected to prove the API contract: multipart fields,
 * derived file_type, and that the send API receives a real key — never the
 * local file path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FeishuChannel } from '../index';
import type { FeishuAdapterOptions } from '../types';
import type { NormalizedReply } from '../../../types';

const TOKEN_BODY = JSON.stringify({
  code: 0,
  msg: 'ok',
  tenant_access_token: 'test-token',
  expire: 3600,
});
const SEND_BODY = JSON.stringify({
  code: 0,
  msg: 'ok',
  data: { message_id: 'om_sent', msg_type: 'image', create_time: '0' },
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeChannel(
  overrides: Partial<Pick<FeishuAdapterOptions, 'onProcessingStatus'>> = {},
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
    onProcessingStatus: overrides.onProcessingStatus,
  };
  return new FeishuChannel(options);
}

function stubFetch(respond: (url: string, call: FetchCall) => Response, calls: FetchCall[]): void {
  vi.stubGlobal(
    'fetch',
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: init?.method || 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body,
      };
      calls.push(call);
      return respond(call.url, call);
    }) as unknown as typeof fetch,
  );
}

function tokenResponse(): Response {
  return new Response(TOKEN_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sendResponse(): Response {
  return new Response(SEND_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function formField(body: unknown, field: string): FormDataEntryValue | null {
  if (!(body instanceof FormData)) return null;
  return body.get(field);
}

function writeTempFile(name: string, bytes: number[]): string {
  const filePath = path.join(os.tmpdir(), `duya-feishu-upload-test-${name}`);
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FeishuChannel outbound media upload (todo #1)', () => {
  it('sendReply(photo) uploads the image then sends with the returned image_key', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      if (url.endsWith('/im/v1/images')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { image_key: 'img_v2_uploaded' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/im/v1/messages')) return sendResponse();
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const imagePath = writeTempFile('photo.png', [0x89, 0x50, 0x4e, 0x47]);
    const reply = {
      type: 'media',
      mediaType: 'photo',
      filePath: imagePath,
    } as unknown as NormalizedReply;

    const result = await channel.sendReply('oc_chat', reply);

    expect(result.ok).toBe(true);
    expect(result.platformMsgId).toBe('om_sent');

    const uploadCall = calls.find((c) => c.url.endsWith('/im/v1/images'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall!.headers['Authorization']).toBe('Bearer test-token');
    expect(formField(uploadCall!.body, 'image_type')).toBe('message');
    // The binary part carries the file name of the local path.
    expect((uploadCall!.body as FormData).get('image')).toBeInstanceOf(File);

    const sendCall = calls.find((c) => c.url.includes('/im/v1/messages'));
    expect(sendCall).toBeDefined();
    const sendPayload = JSON.parse(sendCall!.body as string);
    expect(sendPayload.msg_type).toBe('image');
    expect(sendPayload.content).toContain('img_v2_uploaded');
    // The local path must never leak into the send payload.
    expect(sendCall!.body as string).not.toContain(imagePath);
  });

  it('uploadFile derives file_type from the extension and returns the file_key', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      if (url.endsWith('/im/v1/files')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { file_key: 'file_v2_uploaded' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const pdfPath = writeTempFile('doc.pdf', [0x25, 0x50, 0x44, 0x46]);
    const fileKey = await channel.uploadFile(pdfPath);

    expect(fileKey).toBe('file_v2_uploaded');
    const uploadCall = calls.find((c) => c.url.endsWith('/im/v1/files'));
    expect(uploadCall).toBeDefined();
    expect(formField(uploadCall!.body, 'file_type')).toBe('pdf');
    expect(formField(uploadCall!.body, 'file_name')).toBe(path.basename(pdfPath));
  });

  it('sendReply(document) uploads then sends a file message with the key', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      if (url.endsWith('/im/v1/files')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { file_key: 'file_v2_doc' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/im/v1/messages')) return sendResponse();
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const filePath = writeTempFile('report.pdf', [0x25, 0x50, 0x44, 0x46]);
    const reply = {
      type: 'media',
      mediaType: 'document',
      filePath,
    } as unknown as NormalizedReply;

    const result = await channel.sendReply('oc_chat', reply);

    expect(result.ok).toBe(true);
    const sendCall = calls.find((c) => c.url.includes('/im/v1/messages'));
    const sendPayload = JSON.parse(sendCall!.body as string);
    expect(sendPayload.msg_type).toBe('file');
    expect(sendPayload.content).toContain('file_v2_doc');
    expect(sendCall!.body as string).not.toContain(filePath);
  });

  it('sendReply(media) returns ok:false when the upload fails', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      if (url.endsWith('/im/v1/images')) {
        return new Response(JSON.stringify({ code: 230001, msg: 'image too large' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const imagePath = writeTempFile('toobig.png', [0x00]);
    const reply = {
      type: 'media',
      mediaType: 'photo',
      filePath: imagePath,
    } as unknown as NormalizedReply;

    const result = await channel.sendReply('oc_chat', reply);

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('230001');
    // No send call was attempted after the failed upload.
    expect(calls.some((c) => c.url.includes('/im/v1/messages'))).toBe(false);
  });

  it('sendReply(media) surfaces the real send-API error, not [object Object]', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      if (url.endsWith('/im/v1/images')) {
        return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { image_key: 'img_v2_ok' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/im/v1/messages')) {
        return new Response(JSON.stringify({
          code: 230002,
          msg: 'Bot/User can NOT be out of the chat',
          error: { log_id: 'test-log-id' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const imagePath = writeTempFile('sendfail.png', [0x89, 0x50]);
    const reply = {
      type: 'media',
      mediaType: 'photo',
      filePath: imagePath,
    } as unknown as NormalizedReply;

    const result = await channel.sendReply('oc_chat', reply);

    expect(result.ok).toBe(false);
    // The thrown FeishuApiError must be a real Error carrying code + msg +
    // log_id in the message (regression: used to be a plain object that
    // upper layers rendered as "[object Object]").
    expect(String(result.error)).toContain('feishu api error 230002');
    expect(String(result.error)).toContain('Bot/User can NOT be out of the chat');
    expect(String(result.error)).toContain('test-log-id');
    expect(String(result.error)).not.toContain('[object Object]');
  });

  it('uploadImage rejects files over the 10 MB image limit without a request', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response('unexpected', { status: 404 });
    }, calls);

    const channel = makeChannel();
    const bigPath = path.join(os.tmpdir(), 'duya-feishu-upload-test-big.png');
    fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1));

    await expect(channel.uploadImage(bigPath)).rejects.toThrow('10 MB');
    // Rejected locally: only no upload call was made (no token fetch either).
    expect(calls).toHaveLength(0);
  });
});

describe('FeishuChannel.setProcessingStatus (todo #2)', () => {
  it('never calls the urgent_app endpoint and forwards to onProcessingStatus', async () => {
    const calls: FetchCall[] = [];
    stubFetch((url) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) return tokenResponse();
      return new Response('unexpected', { status: 404 });
    }, calls);

    const onProcessingStatus = vi.fn(async () => {});
    const channel = makeChannel({ onProcessingStatus });

    await channel.setProcessingStatus('start', 'om_msg', 'oc_chat');

    expect(onProcessingStatus).toHaveBeenCalledTimes(1);
    expect(onProcessingStatus).toHaveBeenCalledWith('start', 'om_msg', 'oc_chat');
    // The urgent_app misuse is gone: no request at all (not even a token
    // fetch) may target the urgent endpoint.
    expect(calls.some((c) => c.url.includes('/urgent'))).toBe(false);
  });
});

/**
 * telegram-connector.test.ts — unit tests for the Telegram long-polling
 * inbound connector (plan 488 P6).
 *
 * fetch is injected, so no network access happens; the wake callback is
 * captured and asserted against parsed envelopes. Electron's
 * `app.getPath('userData')` is mocked to a per-test temp dir so media
 * attachments persist to a real filesystem (plan 507 P2.5).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TelegramChannelConnector } from '../telegram-connector';
import type { ChannelInboundEnvelope } from '../../../packages/agent/src/channels/types';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => mocks.userDataDir,
  },
}));

let tmpRoot: string;

function fetchWithUpdates(updates: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 })) as unknown as typeof fetch;
}

function neverResolvingFetch(): typeof fetch {
  return (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }) as unknown as typeof fetch;
}

function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('TelegramChannelConnector', () => {
  let onInbound: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onInbound = vi.fn();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-telegram-connector-'));
    mocks.userDataDir = tmpRoot;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('parses text messages into envelopes and invokes the callback', async () => {
    let polls = 0;
    const oneShotFetch = (async () => {
      polls += 1;
      if (polls === 1) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 1,
                  text: 'hello there',
                  from: { username: 'alice' },
                  chat: { id: 4242 },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: oneShotFetch,
      // Stop right after the first poll resolves.
      pollTimeoutSec: 0,
      errorBackoffMs: 1,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    expect(onInbound).toHaveBeenCalledTimes(1);
    const [agentId, envelope] = onInbound.mock.calls[0] as [string, ChannelInboundEnvelope];
    expect(agentId).toBe('bot-x');
    expect(envelope.address).toEqual({ platform: 'telegram', chat: '4242' });
    expect(envelope.sender).toBe('alice');
    expect(envelope.text).toBe('hello there');
    expect(envelope.reaction).toBeNull();
  });

  it('ignores non-text updates (no callback)', async () => {
    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: fetchWithUpdates([{ update_id: 11, message: { message_id: 2, chat: { id: 1 } } }]),
      pollTimeoutSec: 0,
      errorBackoffMs: 1,
    });
    connector.start();
    await new Promise((r) => setTimeout(r, 50));
    await connector.stop();
    expect(onInbound).not.toHaveBeenCalled();
  });

  it('survives poll failures (backoff, keeps running)', async () => {
    let calls = 0;
    const flakyFetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('network down');
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: flakyFetch,
      pollTimeoutSec: 0,
      errorBackoffMs: 1,
    });
    connector.start();
    await waitFor(() => calls >= 2);
    await connector.stop();
    expect(connector.isRunning).toBe(false);
  });

  it('stop() aborts a hanging long poll', async () => {
    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: neverResolvingFetch(),
      pollTimeoutSec: 60,
      errorBackoffMs: 1,
    });
    connector.start();
    await new Promise((r) => setTimeout(r, 20));
    await connector.stop();
    expect(connector.isRunning).toBe(false);
  });

  it('persists a photo update as an inbound attachment', async () => {
    let getUpdatesCalls = 0;
    const mediaFetch = (async (input: string) => {
      if (input.includes('/getUpdates')) {
        getUpdatesCalls += 1;
        const result =
          getUpdatesCalls === 1
            ? [
                {
                  update_id: 21,
                  message: {
                    message_id: 5,
                    from: { username: 'bob' },
                    chat: { id: 77 },
                    caption: 'look at this',
                    // Ascending sizes — the connector must pick the largest.
                    photo: [
                      { file_id: 'pic_small', width: 100, height: 80 },
                      { file_id: 'pic_large', width: 800, height: 600, file_size: 999 },
                    ],
                  },
                },
              ]
            : [];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      if (input.includes('/getFile')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: 'photos/pic_large.jpg', file_size: 999 },
          }),
          { status: 200 },
        );
      }
      if (input.includes('/file/bot')) {
        // JPEG magic bytes stand in for the downloaded photo.
        return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) as unknown as BodyInit, {
          status: 200,
        });
      }
      throw new Error(`unexpected url: ${input}`);
    }) as unknown as typeof fetch;

    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: mediaFetch,
      pollTimeoutSec: 0,
      errorBackoffMs: 1,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    const [agentId, envelope] = onInbound.mock.calls[0] as [string, ChannelInboundEnvelope];
    expect(agentId).toBe('bot-x');
    expect(envelope.text).toBe('look at this');
    expect(envelope.attachments).toBeDefined();
    expect(envelope.attachments!.length).toBe(1);
    const att = envelope.attachments![0];
    expect(att.name).toBe('photo.jpg');
    expect(att.mimeType).toBe('image/jpeg');
    expect(att.kind).toBe('image');
    expect(att.size).toBe(6);
    expect(fs.existsSync(att.path)).toBe(true);
  });

  it('persists a .md document as an uploaded file (no content injection)', async () => {
    let getUpdatesCalls = 0;
    const mediaFetch = (async (input: string) => {
      if (input.includes('/getUpdates')) {
        getUpdatesCalls += 1;
        const result =
          getUpdatesCalls === 1
            ? [
                {
                  update_id: 22,
                  message: {
                    message_id: 6,
                    from: { username: 'carol' },
                    chat: { id: 88 },
                    document: { file_id: 'doc_1', file_name: 'notes.md', file_size: 40 },
                  },
                },
              ]
            : [];
        return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      }
      if (input.includes('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'docs/notes.md', file_size: 40 } }),
          { status: 200 },
        );
      }
      if (input.includes('/file/bot')) {
        return new Response(Buffer.from('# note\nbody') as unknown as BodyInit, { status: 200 });
      }
      throw new Error(`unexpected url: ${input}`);
    }) as unknown as typeof fetch;

    const connector = new TelegramChannelConnector({
      agentId: 'bot-x',
      token: 'tok',
      onInbound,
      fetchFn: mediaFetch,
      pollTimeoutSec: 0,
      errorBackoffMs: 1,
    });
    connector.start();
    await waitFor(() => onInbound.mock.calls.length > 0);
    await connector.stop();

    const [, envelope] = onInbound.mock.calls[0] as [string, ChannelInboundEnvelope];
    // No caption/text on this media message.
    expect(envelope.text).toBe('');
    expect(envelope.attachments!.length).toBe(1);
    const att = envelope.attachments![0];
    // .md is NOT injected into the message text; it is persisted as a file
    // and the content is not echoed back.
    expect(att.name).toBe('notes.md');
    expect(att.mimeType).toBe('text/markdown');
    expect(att.kind).toBe('document');
    expect(envelope.text).not.toContain('# note');
  });
});

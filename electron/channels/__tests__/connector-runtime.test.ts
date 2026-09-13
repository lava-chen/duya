/**
 * connector-runtime.test.ts — live-outbound registry (plan 488). Feishu/Weixin
 * outbound must reuse the live adapter instance; this registry is how
 * `channelDelivery` prefers it over stateless HTTP transports.
 *
 * A temp ConfigStore is injected (plan 526 shared agents root) and electron's
 * app is mocked so the module chain never touches real user data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Mock electron away from the real app data before importing.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-runtime-test-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import { ConfigStore } from '../../config/store';
import { _setConfigStoreForTest } from '../../config/store-instance';
import {
  registerLiveOutbound,
  unregisterLiveOutbound,
  getLiveOutbound,
  channelOutboundToNormalizedReply,
} from '../connector-runtime';
import type { ChannelOutboundMessage } from '../../../packages/agent/src/channels/types';

_setConfigStoreForTest(
  new ConfigStore({
    configPath: path.join(userData, 'config.toml'),
    secretsPath: path.join(userData, 'secrets.json'),
  }),
);

describe('connector-runtime live outbound registry', () => {
  beforeEach(() => {
    // Re-inject per test: other suites in the same worker may reset it.
    _setConfigStoreForTest(
      new ConfigStore({
        configPath: path.join(userData, 'config.toml'),
        secretsPath: path.join(userData, 'secrets.json'),
      }),
    );
  });

  afterEach(() => {
    _setConfigStoreForTest(undefined);
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('routes by agent:platform and is removable', async () => {
    const sender = vi.fn(async (_chatId: string, _outbound: ChannelOutboundMessage) => {});
    registerLiveOutbound('agent-a', 'feishu', sender);
    registerLiveOutbound('agent-b', 'weixin', sender);

    const a = getLiveOutbound('agent-a', 'feishu');
    const b = getLiveOutbound('agent-b', 'weixin');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Different agent / platform must not collide.
    expect(getLiveOutbound('agent-a', 'weixin')).toBeUndefined();
    expect(getLiveOutbound('agent-b', 'feishu')).toBeUndefined();

    if (a) {
      await a('chat-1', { kind: 'text', content: 'hi' });
    }
    expect(sender).toHaveBeenCalledWith('chat-1', { kind: 'text', content: 'hi' });

    unregisterLiveOutbound('agent-a', 'feishu');
    expect(getLiveOutbound('agent-a', 'feishu')).toBeUndefined();
  });
});

describe('channelOutboundToNormalizedReply (plan 507 P3.1)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-reply-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fileUrl(name: string): string {
    // pathToFileURL yields a platform-appropriate file:// URL for a real path.
    return `${cryptoURL().href}${name}`;
  }

  function makeFile(name: string, content = 'not empty'): string {
    const abs = path.join(tempDir, name);
    fs.writeFileSync(abs, content);
    return abs;
  }

  it('maps a real file:// image attachment to a photo MediaReply', () => {
    const abs = makeFile('chart.png');
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: urlFor(abs),
      caption: 'weekly chart',
    });
    expect(reply).toEqual({
      type: 'media',
      mediaType: 'photo',
      filePath: abs,
      caption: 'weekly chart',
    });
  });

  it('maps a file:// xlsx attachment to a document MediaReply without caption', () => {
    const abs = makeFile('report.xlsx');
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: urlFor(abs),
    });
    expect(reply).toEqual({
      type: 'media',
      mediaType: 'document',
      filePath: abs,
    });
  });

  it('falls back to content as the MediaReply caption when caption is absent', () => {
    const abs = makeFile('clip.mp4');
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: urlFor(abs),
      content: 'the demo clip',
    });
    expect(reply).toEqual({
      type: 'media',
      mediaType: 'video',
      filePath: abs,
      caption: 'the demo clip',
    });
  });

  it('falls back to text-with-link when the file:// attachment is missing', () => {
    const missingUrl = pathToFileURL(path.join(tempDir, 'gone.png')).href;
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: missingUrl,
      caption: 'chart',
    });
    expect(reply).toEqual({ type: 'text', text: `chart\n${missingUrl}` });
  });

  it('falls back to text-with-link when the file:// attachment is empty', () => {
    const abs = makeFile('empty.png', '');
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: urlFor(abs),
      caption: 'chart',
    });
    expect(reply).toEqual({ type: 'text', text: `chart\n${urlFor(abs)}` });
  });

  it('keeps https:// attachments as text-with-link degradation', () => {
    const reply = channelOutboundToNormalizedReply({
      kind: 'attachment',
      url: 'https://example.com/a.png',
      caption: 'chart',
    });
    expect(reply).toEqual({
      type: 'text',
      text: 'chart\nhttps://example.com/a.png',
    });
  });

  it('maps plain text outbound to a text reply', () => {
    expect(
      channelOutboundToNormalizedReply({ kind: 'text', content: 'hi' }),
    ).toEqual({ type: 'text', text: 'hi' });
  });
});

function urlFor(abs: string): string {
  return pathToFileURL(abs).href;
}
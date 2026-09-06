/**
 * connector-runtime.test.ts — live-outbound registry (plan 488). Feishu/Weixin
 * outbound must reuse the live adapter instance; this registry is how
 * `channelDelivery` prefers it over stateless HTTP transports.
 *
 * Electron's `app.getPath('userData')` is mocked to a temp dir so the module
 * (and its fs-backed secret store) loads without touching real user data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron USER DATA away from the real app data before importing.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-runtime-test-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import {
  registerLiveOutbound,
  unregisterLiveOutbound,
  getLiveOutbound,
} from '../connector-runtime';
import type { ChannelOutboundMessage } from '../../../packages/agent/src/channels/types';

describe('connector-runtime live outbound registry', () => {
  afterEach(() => {
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
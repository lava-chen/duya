import { beforeEach, expect, it, vi } from 'vitest';
import type { FeishuAdapterOptions } from '../gateway-adapters';
import { FeishuChannelConnector } from '../feishu-connector';

const mocks = vi.hoisted(() => ({ options: null as FeishuAdapterOptions | null,
  persist: vi.fn(async () => ({ attachment: { name: 'photo.png', path: '/fixture/photo.png', size: 12,
    mimeType: 'image/png', kind: 'image' as const } })) }));
vi.mock('../gateway-adapters', () => ({ createFeishuChannel: (options: FeishuAdapterOptions) => {
  mocks.options = options;
  return { start: async () => {}, stop: async () => {} };
} }));
vi.mock('../agent-session-channels', () => ({ getConnectorCredential: () => 'fixture-credential' }));
vi.mock('../attachment-store', () => ({ persistInboundAttachment: mocks.persist }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  LogComponent: { Gateway: 'Gateway' } }));
beforeEach(() => { mocks.options = null; });

it('preserves per-message identity and waits for admission instead of fire-and-forget', async () => {
  let commit!: () => void;
  const receive = vi.fn(async () => new Promise<void>((resolve) => { commit = resolve; }));
  const connector = new FeishuChannelConnector({ agentId: 'bot', onInbound: receive, ackAfterHandling: () => true });
  connector.start();
  await vi.waitFor(() => expect(mocks.options).not.toBeNull());
  let done = false;
  const result = mocks.options!.onMessage('chat', 'sender', 'hello', 'om_1').then(() => { done = true; });
  expect(receive).toHaveBeenCalledWith('bot', expect.objectContaining({ sourceEventId: 'om_1', text: 'hello' }));
  await Promise.resolve();
  expect(done).toBe(false);
  commit(); await result;
  expect(done).toBe(true);
  expect(mocks.options!.ackAfterHandling?.()).toBe(true);
  await connector.stop();
});

it('passes media and thread IDs through the same envelope and propagates failures', async () => {
  const receive = vi.fn(async (_bot: string, _envelope: unknown) => {});
  const connector = new FeishuChannelConnector({ agentId: 'bot', onInbound: receive });
  connector.start();
  await vi.waitFor(() => expect(mocks.options).not.toBeNull());
  await mocks.options!.onImageMessage('chat', 'sender', 'image_key', 'om_media', '/tmp/photo.png');
  expect(receive).toHaveBeenLastCalledWith('bot', expect.objectContaining({ sourceEventId: 'om_media',
    attachments: [expect.objectContaining({ path: '/fixture/photo.png' })] }));
  await mocks.options!.onThreadMessage!('thread', 'chat', 'sender', 'reply', 'om_thread');
  expect(receive).toHaveBeenLastCalledWith('bot', expect.objectContaining({ sourceEventId: 'om_thread' }));
  receive.mockRejectedValueOnce(new Error('storage_unavailable'));
  await expect(mocks.options!.onMessage('chat', 'sender', 'retry', 'om_failed')).rejects.toThrow('storage_unavailable');
  await connector.stop();
});

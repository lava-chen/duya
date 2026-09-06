/**
 * telegram-connector.test.ts — unit tests for the Telegram long-polling
 * inbound connector (plan 488 P6).
 *
 * fetch is injected, so no network access happens; the wake callback is
 * captured and asserted against parsed envelopes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { TelegramChannelConnector } from '../telegram-connector';
import type { ChannelInboundEnvelope } from '../../../packages/agent/src/channels/types';

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
});

/**
 * channel-ack-redrive.test.ts — grok ack-obligation parity: an inbound
 * channel wake whose run produces no SendMessage leaves the external sender
 * waiting forever. The run is re-driven (hidden '[channel-ack-redrive]'
 * turn) up to 3 times, the budget resets when a new message arrives or a
 * delivery lands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wake-run', () => ({
  runWakePromptInExistingSession: vi.fn(async () => ({ output: 'silent', events: [] })),
}));

vi.mock('../../db/core-connection', () => ({
  getCoreStores: () => ({
    wakes: {
      get: () => null,
      persist: () => undefined,
      clear: () => false,
      listAll: () => [],
      pruneStale: () => 0,
    },
  }),
}));

import { reviveForInbound, inboundEnvelopeStore, runUsedChannelDelivery, _resetChannelAckRedriveForTest } from '../channels';
import type { ChannelInboundEnvelope } from '../../../packages/agent/src/channels/types';

function envelope(text: string): ChannelInboundEnvelope {
  return { address: { platform: 'telegram', chat: '100' }, sender: 'alice', text, reaction: null };
}

beforeEach(async () => {
  vi.useFakeTimers();
  _resetChannelAckRedriveForTest();
  inboundEnvelopeStore.clear();
  const { runWakePromptInExistingSession } = await import('../wake-run');
  vi.mocked(runWakePromptInExistingSession).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runUsedChannelDelivery', () => {
  it('detects a SendMessage tool call in the run events', () => {
    expect(runUsedChannelDelivery([{ type: 'tool_use', data: { name: 'SendMessage' } }])).toBe(true);
    expect(runUsedChannelDelivery([{ type: 'tool_use', data: { name: 'send_to_agent' } }])).toBe(false);
    expect(runUsedChannelDelivery([])).toBe(false);
  });
});

describe('ack redrive', () => {
  it('delivered runs are left alone (no redrive scheduled)', async () => {
    const { runWakePromptInExistingSession } = await import('../wake-run');
    const runFn = vi.mocked(runWakePromptInExistingSession);
    runFn.mockImplementationOnce(async () => ({
      output: 'sent',
      events: [{ type: 'tool_use', data: { name: 'SendMessage' } }],
    }));

    inboundEnvelopeStore.set('bot:qa', [envelope('hello')]);
    await reviveForInbound('bot:qa');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(runFn).toHaveBeenCalledTimes(1); // only the original run
  });

  it('silent runs re-drive up to 3 times with the ack prompt', async () => {
    const { runWakePromptInExistingSession } = await import('../wake-run');
    const runFn = vi.mocked(runWakePromptInExistingSession);

    inboundEnvelopeStore.set('bot:qa', [envelope('are you there?')]);
    await reviveForInbound('bot:qa');
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(runFn.mock.calls[0][1]).toContain('[inbound]');

    // idle delay 5s → first redrive
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(runFn.mock.calls[1][1]).toContain('[channel-ack-redrive]');
    expect(runFn.mock.calls[1][1]).toContain('are you there?');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runFn).toHaveBeenCalledTimes(4);
    // 1 original + 3 redrives — the budget is exhausted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runFn).toHaveBeenCalledTimes(4);
  });

  it('a delivery during the ladder clears the remaining redrives', async () => {
    const { runWakePromptInExistingSession } = await import('../wake-run');
    const runFn = vi.mocked(runWakePromptInExistingSession);
    // Second run (first redrive) finally delivers.
    runFn.mockImplementationOnce(async () => ({ output: '', events: [] }));
    runFn.mockImplementationOnce(async () => ({
      output: 'ok',
      events: [{ type: 'tool_use', data: { name: 'SendMessage' } }],
    }));

    inboundEnvelopeStore.set('bot:qa', [envelope('hello')]);
    await reviveForInbound('bot:qa');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runFn).toHaveBeenCalledTimes(2); // ladder stopped after delivery
  });
});

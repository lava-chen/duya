/**
 * channel-envelope-persistence.test.ts — grok-gap fix: channel inbound
 * envelopes used to live only in a process-local Map, so a restart dropped
 * undelivered messages even though the durable `connector.inbound` wake
 * marker survived (its revive found an empty store and no-oped). The marker
 * row now carries the envelopes themselves: appended at inbound, cleared at
 * dequeue, restored (and re-enqueued per chat) by wake-rearm.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, {
    kind: string;
    workId: string;
    agentId: string;
    lane: string;
    markedAtMs: number;
    title: string | null;
    quietOriginJson: string | null;
  }>();
  const persisted: Array<{ kind: string; workId: string; quietOriginJson: string | null }> = [];
  const cleared: Array<{ kind: string; workId: string }> = [];
  const pendingWakeApi = {
    getPendingWake: async (_kind: string, workId: string) => rows.get(workId) ?? null,
    persistPendingWake: async (input: { kind: string; workId: string; agentId: string; lane?: string; title?: string | null; quietOriginJson?: string | null }) => {
      persisted.push({
        kind: input.kind,
        workId: input.workId,
        quietOriginJson: input.quietOriginJson ?? null,
      });
      rows.set(input.workId, {
        kind: input.kind,
        workId: input.workId,
        agentId: input.agentId,
        lane: input.lane ?? 'background',
        markedAtMs: Date.now(),
        title: input.title ?? null,
        quietOriginJson: input.quietOriginJson ?? null,
      });
    },
    clearPendingWake: async (kind: string, workId: string) => {
      cleared.push({ kind, workId });
      return rows.delete(workId);
    },
    listPendingWakes: async () => Array.from(rows.values()),
    pruneStalePendingWakes: async () => 0,
  };
  return {
    rows,
    persisted,
    cleared,
    pendingWakeApi,
    enqueuedInbound: [] as Array<{ sessionId: string; envelopeId: string; text: string }>,
    notified: [] as string[],
  };
});

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostLocalPendingWakeApi: () => mocks.pendingWakeApi,
  getDesktopHostSessionApi: () => ({ appendTimeline: async () => ({ writtenCount: 0 }) }),
}));

// Partial mock: real dispatcher functions stay available (the clear-on-
// dequeue test drives the REAL enqueue + drain), only the two entry points
// that would kick live runs are stubbed out.
vi.mock('../wake-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wake-dispatcher')>();
  return {
    ...actual,
    enqueueInboundWake: (sessionId: string, opts: { envelopeId: string; text?: string }) => {
      mocks.enqueuedInbound.push({ sessionId, envelopeId: opts.envelopeId, text: opts.text ?? '' });
      return 'added' as const;
    },
    notifySessionIdle: (sessionId: string) => {
      mocks.notified.push(sessionId);
    },
  };
});

vi.mock('../wake-run', () => ({
  runWakePromptInExistingSession: async () => ({ output: '', events: [] }),
}));

import { wakeForInbound, inboundEnvelopeStore, restoreInboundEnvelopes, loadPersistedInboundEnvelopes } from '../channels';
import { rearmPendingWakes } from '../wake-rearm';
import type { ChannelInboundEnvelope } from '@duya/agent-protocol/channels';

function envelope(platform: string, chat: string, text: string): ChannelInboundEnvelope {
  return { address: { platform, chat }, sender: 'alice', text, reaction: null };
}

beforeEach(() => {
  mocks.rows.clear();
  mocks.persisted.length = 0;
  mocks.cleared.length = 0;
  mocks.enqueuedInbound.length = 0;
  mocks.notified.length = 0;
  inboundEnvelopeStore.clear();
});

describe('durable inbound envelope persistence', () => {
  it('appends each envelope to the Host pending-wake row and seeds the in-memory store', async () => {
    wakeForInbound('bot:qa', envelope('telegram', '100', 'hello'));
    wakeForInbound('bot:qa', envelope('telegram', '100', 'again'));
    wakeForInbound('bot:qa', envelope('feishu', 'oc_1', 'different chat'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.persisted).toHaveLength(3);
    expect(mocks.persisted.every((p) => p.kind === 'connector.inbound' && p.workId === 'bot:qa')).toBe(true);

    const stored = loadPersistedInboundEnvelopes({ quietOriginJson: mocks.rows.get('bot:qa')!.quietOriginJson });
    expect(stored).toHaveLength(3);
    expect(stored.map((e) => e.text)).toEqual(['hello', 'again', 'different chat']);
    expect(inboundEnvelopeStore.get('bot:qa')!.map((e) => e.text)).toEqual(['hello', 'again', 'different chat']);
  });

  it('clears the durable row when the wake item is consumed (dispatcher dequeue)', async () => {
    const { _resetWakeDispatcherForTest, _setWakeDispatcherDeps } = await import('../wake-dispatcher');
    _resetWakeDispatcherForTest();
    _setWakeDispatcherDeps({ isLocked: () => false, runWake: async () => ({ output: '', events: [] }) });
    try {
      // Seed a durable row, then enqueue + drain through the real dispatcher.
      // clearPersistedItem runs at dequeue — before the connector.inbound
      // branch's fire-and-forget revive — and must clear the session row
      // keyed by (kind, agentId).
      mocks.rows.set('bot:qa', {
        kind: 'connector.inbound',
        workId: 'bot:qa',
        agentId: 'bot:qa',
        lane: 'background',
        markedAtMs: Date.now(),
        title: null,
        quietOriginJson: JSON.stringify({ envelopes: [envelope('telegram', '100', 'hello')] }),
      });
      inboundEnvelopeStore.set('bot:qa', [envelope('telegram', '100', 'hello')]);

      const { enqueueWakeItemForSession } = await import('../wake-dispatcher');
      enqueueWakeItemForSession('bot:qa', {
        id: 'inbound:bot:qa:telegram:100',
        source: 'connector.inbound',
        lane: 'background',
        agentId: 'bot:qa',
        enqueuedAtMs: Date.now(),
        payload: { kind: 'inbound', envelopeId: 'bot:qa:telegram:100' },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(mocks.cleared).toContainEqual({ kind: 'connector.inbound', workId: 'bot:qa' });
    } finally {
      _resetWakeDispatcherForTest();
    }
  });

  it('rearm restores envelopes and re-enqueues one wake per platform:chat', async () => {
    mocks.rows.set('bot:qa', {
      kind: 'connector.inbound',
      workId: 'bot:qa',
      agentId: 'bot:qa',
      lane: 'background',
      markedAtMs: Date.now(),
      title: null,
      quietOriginJson: JSON.stringify({
        envelopes: [envelope('telegram', '100', 'hello'), envelope('telegram', '100', 'again'), envelope('feishu', 'oc_1', 'ping')],
      }),
    });

    await rearmPendingWakes();

    expect(inboundEnvelopeStore.get('bot:qa')!.map((e) => e.text)).toEqual(['hello', 'again', 'ping']);
    // telegram:100 collapsed into one wake; feishu:oc_1 is a second one.
    expect(mocks.enqueuedInbound.map((e) => e.envelopeId)).toEqual([
      'bot:qa:telegram:100',
      'bot:qa:feishu:oc_1',
    ]);
    expect(mocks.notified).toContain('bot:qa');
  });

  it('rearm skips connector.inbound rows with no envelopes', async () => {
    mocks.rows.set('bot:qa', {
      kind: 'connector.inbound',
      workId: 'bot:qa',
      agentId: 'bot:qa',
      lane: 'background',
      markedAtMs: Date.now(),
      title: null,
      quietOriginJson: JSON.stringify({ envelopes: [] }),
    });
    await rearmPendingWakes();
    expect(mocks.enqueuedInbound).toHaveLength(0);
  });

  it('parses malformed durable payloads defensively', () => {
    expect(loadPersistedInboundEnvelopes(null)).toEqual([]);
    expect(loadPersistedInboundEnvelopes({ quiet_origin_json: 'not json' })).toEqual([]);
    expect(loadPersistedInboundEnvelopes({ quiet_origin_json: JSON.stringify({ nope: 1 }) })).toEqual([]);
  });

  it('restoreInboundEnvelopes appends without clobbering pending envelopes', () => {
    inboundEnvelopeStore.set('bot:qa', [envelope('telegram', '1', 'first')]);
    restoreInboundEnvelopes('bot:qa', [envelope('telegram', '2', 'second')]);
    expect(inboundEnvelopeStore.get('bot:qa')!.map((e) => e.text)).toEqual(['first', 'second']);
  });
});

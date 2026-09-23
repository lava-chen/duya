/**
 * automation-fire-persistence.test.ts — grok-gap fix: queued automation
 * fires were never persisted (the wake-rearm 'automation.fire' case was
 * unreachable dead code), and even the hypothetical rearm collapsed every
 * fire of a job to fireKey 'rearm'. Fires now persist one row each keyed
 * `<jobKey>:<fireKey>`, are cleared at dequeue, and rearm restores the real
 * fireKey + trigger.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, { kind: string; work_id: string; agent_id: string; lane: string; title: string | null; marked_at_ms: number; quiet_origin_json: string | null }>();
  return {
    rows,
    persisted: [] as Array<{ kind: string; workId: string; agentId: string; lane: string; title: string | null; quietOriginJson: string | null }>,
    cleared: [] as Array<{ kind: string; workId: string }>,
  };
});

vi.mock('../../db/core-connection', () => ({
  getCoreStores: () => ({
    wakes: {
      persist: (input: { kind: string; workId: string; agentId: string; lane?: string; title?: string | null; quietOriginJson?: string | null }) => {
        mocks.persisted.push(input);
        mocks.rows.set(input.workId, {
          kind: input.kind,
          work_id: input.workId,
          agent_id: input.agentId,
          lane: input.lane ?? 'background',
          title: input.title ?? null,
          marked_at_ms: Date.now(),
          quiet_origin_json: input.quietOriginJson ?? null,
        });
      },
      clear: (kind: string, workId: string) => {
        mocks.cleared.push({ kind, workId });
        return mocks.rows.delete(workId);
      },
      listAll: () => Array.from(mocks.rows.values()),
      get: () => null,
      pruneStale: () => 0,
    },
  }),
}));

import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  enqueueAutomationWake,
  type WakeDispatcherDeps,
} from '../wake-dispatcher';
import { rearmPendingWakes } from '../wake-rearm';
import type { WakeItem } from '../../../packages/agent/src/wake/types';
import type { WakePayload } from '../../../packages/agent/src/wake/types';

const BOT_SESSION = 'bot:news-bot';

function makeDeps(opts: { parked?: boolean } = {}): WakeDispatcherDeps & {
  runWake: ReturnType<typeof vi.fn>;
  seenPayloads: WakePayload[];
} {
  const seenPayloads: WakePayload[] = [];
  return {
    isLocked: () => opts.parked === true,
    runWake: vi.fn(async () => ({ output: 'done', events: [] })),
    resolveRoutinePrompt: (payload) => {
      seenPayloads.push(payload);
      return '[routine] prompt';
    },
    seenPayloads,
  } as unknown as WakeDispatcherDeps & { runWake: ReturnType<typeof vi.fn>; seenPayloads: WakePayload[] };
}

async function flushTurns(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  _resetWakeDispatcherForTest();
  mocks.rows.clear();
  mocks.persisted.length = 0;
  mocks.cleared.length = 0;
});

describe('automation fire persistence', () => {
  it('persists one row per fire keyed `<jobKey>:<fireKey>` and clears it at dequeue', async () => {
    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);

    const outcome = enqueueAutomationWake({
      jobKey: 'morning-digest',
      fireKey: 'fire-abc',
      name: 'Morning digest',
      targetSessionId: BOT_SESSION,
      trigger: 'schedule',
    });
    expect(outcome).toBe('added');

    // Row exists immediately (persist at enqueue).
    expect(mocks.persisted).toHaveLength(1);
    expect(mocks.persisted[0].kind).toBe('automation.fire');
    expect(mocks.persisted[0].workId).toBe('morning-digest:fire-abc');
    expect(JSON.parse(mocks.persisted[0].quietOriginJson!)).toEqual({ fire: { trigger: 'schedule' } });

    // Draining consumes the item and clears the durable row.
    await flushTurns();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(mocks.cleared).toContainEqual({ kind: 'automation.fire', workId: 'morning-digest:fire-abc' });
  });

  it('keeps distinct rows for two parked fires of the same job', () => {
    // Parked sessions never dequeue, so both rows coexist — the upsert-collision
    // the composite workId prevents.
    _setWakeDispatcherDeps(makeDeps({ parked: true }));
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f1', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f2', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    const fireRows = mocks.persisted.filter((p) => p.kind === 'automation.fire');
    expect(fireRows.map((p) => p.workId)).toEqual(['j:f1', 'j:f2']);
    expect(mocks.rows.size).toBe(2);
  });

  it('rearm restores the real fireKey, trigger and event context', async () => {
    mocks.rows.set('j:f9', {
      kind: 'automation.fire',
      work_id: 'j:f9',
      agent_id: BOT_SESSION,
      lane: 'background',
      title: 'Event fire',
      marked_at_ms: Date.now(),
      quiet_origin_json: JSON.stringify({ fire: { trigger: 'event', eventSummary: 'PR merged', eventContext: '[pr] #1' } }),
    });

    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);
    await rearmPendingWakes();

    expect(deps.seenPayloads).toHaveLength(1);
    const payload = deps.seenPayloads[0] as Extract<WakePayload, { kind: 'automation' }>;
    expect(payload.jobKey).toBe('j');
    expect(payload.fireKey).toBe('f9'); // not collapsed to 'rearm'
    expect(payload.trigger).toBe('event');
    expect(payload.eventSummary).toBe('PR merged');
    expect(payload.eventContext).toBe('[pr] #1');
  });

  it('rearm falls back to fireKey "rearm" for legacy rows without a separator', async () => {
    mocks.rows.set('legacy-job', {
      kind: 'automation.fire',
      work_id: 'legacy-job',
      agent_id: BOT_SESSION,
      lane: 'background',
      title: null,
      marked_at_ms: Date.now(),
      quiet_origin_json: null,
    });

    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);
    await rearmPendingWakes();

    const payload = deps.seenPayloads[0] as Extract<WakePayload, { kind: 'automation' }>;
    expect(payload.jobKey).toBe('legacy-job');
    expect(payload.fireKey).toBe('rearm');
    expect(payload.trigger).toBe('schedule');
  });
});

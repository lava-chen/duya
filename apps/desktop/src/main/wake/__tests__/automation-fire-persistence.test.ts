/**
 * automation-fire-persistence.test.ts — grok-gap fix: queued automation
 * fires were never persisted (the wake-rearm 'automation.fire' case was
 * unreachable dead code), and even the hypothetical rearm collapsed every
 * fire of a job to fireKey 'rearm'. Fires now persist one row each keyed
 * `<jobKey>:<fireKey>`, are cleared at dequeue, and rearm restores the real
 * fireKey + trigger.
 *
 * The durable rows live behind the Desktop Host local pending-wake API
 * (`getDesktopHostLocalPendingWakeApi()`), so that is what is stubbed here —
 * the same seam the sibling `channel-envelope-persistence.test.ts` drives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostPendingWakeInput, HostPendingWakeRow } from '@duya/agent-protocol';

const mocks = vi.hoisted(() => {
  const rows = new Map<string, HostPendingWakeRow>();
  return {
    rows,
    persisted: [] as HostPendingWakeInput[],
    cleared: [] as Array<{ kind: string; workId: string }>,
    /** Ordered log of the durable writes, so "written at enqueue, cleared at
     *  dequeue" is an assertion and not a reading of the source. */
    writes: [] as string[],
    pendingWakeApi: {
      getPendingWake: async (_kind: string, workId: string) => rows.get(workId) ?? null,
      persistPendingWake: async (input: HostPendingWakeInput) => {
        mocks.persisted.push(input);
        mocks.writes.push(`persist:${input.workId}`);
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
        mocks.cleared.push({ kind, workId });
        mocks.writes.push(`clear:${workId}`);
        return rows.delete(workId);
      },
      listPendingWakes: async () => Array.from(rows.values()),
      pruneStalePendingWakes: async () => 0,
    },
  };
});

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostLocalPendingWakeApi: () => mocks.pendingWakeApi,
  getDesktopHostLockApi: () => ({
    isSessionLocked: async () => false,
    getSessionLockOrigin: async () => null,
  }),
  getDesktopHostSessionApi: () => ({ appendTimeline: async () => ({ writtenCount: 0 }) }),
  getDesktopHostLocalSessionApi: () => ({ appendTimeline: async () => ({ writtenCount: 0 }) }),
}));

import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  enqueueAutomationWake,
  type WakeDispatcherDeps,
} from '../wake-dispatcher';
import { rearmPendingWakes } from '../wake-rearm';
import type { WakeItem, WakePayload } from '@duya/agent-protocol';

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
  mocks.writes.length = 0;
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

    // The durable write is queued behind the session's pending-wake write
    // chain, so it lands on a later microtask than the enqueue itself.
    await vi.waitFor(() => {
      expect(mocks.persisted).toHaveLength(1);
    });
    expect(mocks.persisted[0].kind).toBe('automation.fire');
    expect(mocks.persisted[0].workId).toBe('morning-digest:fire-abc');
    expect(JSON.parse(mocks.persisted[0].quietOriginJson!)).toEqual({ fire: { trigger: 'schedule' } });

    // Draining consumes the item and clears the durable row.
    await flushTurns();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(mocks.cleared).toContainEqual({ kind: 'automation.fire', workId: 'morning-digest:fire-abc' });
    // Written at enqueue, cleared at dequeue — never the other way round.
    expect(mocks.writes).toEqual(['persist:morning-digest:fire-abc', 'clear:morning-digest:fire-abc']);
  });

  it('keeps distinct rows for two parked fires of the same job', async () => {
    // Parked sessions never dequeue, so both rows coexist — the upsert-collision
    // the composite workId prevents.
    _setWakeDispatcherDeps(makeDeps({ parked: true }));
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f1', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    enqueueAutomationWake({ jobKey: 'j', fireKey: 'f2', targetSessionId: BOT_SESSION, trigger: 'schedule' });
    // The two writes are serialized on the session's write chain, so they
    // land in enqueue order.
    await vi.waitFor(() => {
      expect(mocks.persisted.filter((p) => p.kind === 'automation.fire')).toHaveLength(2);
    });
    const fireRows = mocks.persisted.filter((p) => p.kind === 'automation.fire');
    expect(fireRows.map((p) => p.workId)).toEqual(['j:f1', 'j:f2']);
    expect(mocks.rows.size).toBe(2);
  });

  it('rearm restores the real fireKey, trigger and event context', async () => {
    mocks.rows.set('j:f9', {
      kind: 'automation.fire',
      workId: 'j:f9',
      agentId: BOT_SESSION,
      lane: 'background',
      title: 'Event fire',
      markedAtMs: Date.now(),
      quietOriginJson: JSON.stringify({ fire: { trigger: 'event', eventSummary: 'PR merged', eventContext: '[pr] #1' } }),
    });

    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);
    await rearmPendingWakes();
    // The rearmed fire is dispatched by the drain, and the prompt resolver
    // runs at dispatch time — so the restored payload is observed once the
    // dispatcher has picked the item up.
    await flushTurns();

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
      workId: 'legacy-job',
      agentId: BOT_SESSION,
      lane: 'background',
      title: null,
      markedAtMs: Date.now(),
      quietOriginJson: null,
    });

    const deps = makeDeps();
    _setWakeDispatcherDeps(deps);
    await rearmPendingWakes();
    await flushTurns();

    const payload = deps.seenPayloads[0] as Extract<WakePayload, { kind: 'automation' }>;
    expect(payload.jobKey).toBe('legacy-job');
    expect(payload.fireKey).toBe('rearm');
    expect(payload.trigger).toBe('schedule');
  });
});

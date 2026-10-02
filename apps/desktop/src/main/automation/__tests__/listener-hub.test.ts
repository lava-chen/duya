/**
 * Plan 476 P2.3d — listener hub tests: collect→poll→match→fire with a fake
 * store + fake pollers, cursor persistence, silent skip when the platform
 * is not connected, and failure isolation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutineListenerHub, type RoutineListenerHubDeps } from '../listener-hub.js';
import { _resetWakeDispatcherForTest, _setWakeDispatcherDeps, type WakeDispatcherDeps } from '../../wake/wake-dispatcher.js';
import type { AutomationCron, RoutineEvent, RoutineEventTrigger } from '../types.js';

const BOT_SESSION = 'bot:news-bot';

function makeJob(overrides: Partial<AutomationCron> = {}): AutomationCron {
  return {
    id: 'job-1',
    name: 'PR watch',
    prompt: 'Report new PRs.',
    schedule: null,
    workingDirectory: '',
    model: '',
    enabled: true,
    concurrencyPolicy: 'skip',
    maxRetries: 3,
    lastRunAt: null,
    lastError: null,
    retryCount: 0,
    agent: 'news-bot',
    eventTriggers: [
      { type: 'github', repo: 'acme/widgets', events: ['pr-opened'] },
    ],
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** In-memory CronFileStore double: only what the hub touches. */
function makeStore(jobs: AutomationCron[]) {
  const cursors = new Map<string, string | null>();
  return {
    jobs,
    load: vi.fn(),
    listCrons: () => jobs,
    getListenerCursor: (_id: string, index: number) => cursors.get(`${_id}:${index}`) ?? null,
    setListenerCursor: (id: string, index: number, cursor: string | null) => {
      cursors.set(`${id}:${index}`, cursor);
    },
    cursors,
  };
}

function ghEvent(kind: string, repo = 'acme/widgets', actor = 'alice'): RoutineEvent {
  return { source: 'github', repo, kind, title: 'T', actor, timestampMs: Date.now() };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('RoutineListenerHub', () => {
  let deps: WakeDispatcherDeps & { runWake: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    _resetWakeDispatcherForTest();
    deps = {
      isLocked: () => false,
      runWake: vi.fn(async () => ({ output: '', events: [] })),
      resolveRoutinePrompt: (payload) =>
        payload.kind === 'automation' && payload.trigger === 'event'
          ? `[event fire] summary=${payload.eventSummary ?? ''} ctx=${payload.eventContext != null ? 'yes' : 'no'} | What you saved to do each time`
          : null,
    };
    _setWakeDispatcherDeps(deps);
  });

  function makeHub(store: ReturnType<typeof makeStore>, overrides: Partial<RoutineListenerHubDeps> = {}) {
    const poll = vi.fn(
      overrides.pollOverride ??
        (async () => ({ events: [] as RoutineEvent[], cursor: 'seeded' })),
    );
    const hub = new RoutineListenerHub({
      store: store as unknown as RoutineListenerHubDeps['store'],
      resolveAccessToken: overrides.resolveAccessToken ?? (async () => 'token'),
      fetchImpl: (async () => ({ json: async () => null })) as unknown as typeof fetch,
      ...overrides,
      pollOverride: poll as unknown as RoutineListenerHubDeps['pollOverride'],
    });
    return { hub, poll };
  }

  it('polls every listener of enabled bot-bound jobs and fires matches', async () => {
    const store = makeStore([makeJob()]);
    const { hub, poll } = makeHub(store, {
      pollOverride: async () => ({ events: [ghEvent('pr-opened')], cursor: 'c2' }),
    });

    await hub.tick();

    expect(poll).toHaveBeenCalledTimes(1);
    expect(store.cursors.get('job-1:0')).toBe('c2');
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    const [sessionId, prompt] = deps.runWake.mock.calls[0] as [string, string];
    expect(sessionId).toBe(BOT_SESSION);
    expect(prompt).toContain('summary=');
    expect(prompt).toContain('ctx=yes');
    expect(prompt).toContain('What you saved to do each time');
  });

  it('does not fire when no event matches the listener', async () => {
    const store = makeStore([makeJob()]);
    const { hub } = makeHub(store, {
      pollOverride: async () => ({ events: [ghEvent('pr-merged')], cursor: 'c2' }),
    });
    await hub.tick();
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
  });

  it('stays silent when the platform has no connected App Connection', async () => {
    const store = makeStore([makeJob()]);
    const { hub, poll } = makeHub(store, { resolveAccessToken: async () => null });
    await hub.tick();
    expect(poll).not.toHaveBeenCalled();
    await flush();
    expect(deps.runWake).not.toHaveBeenCalled();
  });

  it('skips disabled jobs and jobs without a bot binding', async () => {
    const store = makeStore([
      makeJob({ enabled: false }),
      makeJob({ id: 'job-2', agent: null }),
      makeJob({ id: 'job-3', eventTriggers: undefined }),
    ]);
    const { hub, poll } = makeHub(store);
    await hub.tick();
    expect(poll).not.toHaveBeenCalled();
  });

  it('a poll failure keeps the previous cursor and does not wedge the tick', async () => {
    const store = makeStore([makeJob()]);
    let calls = 0;
    const { hub } = makeHub(store, {
      pollOverride: async () => {
        calls += 1;
        if (calls === 1) throw new Error('github auth rejected (HTTP 401)');
        return { events: [ghEvent('pr-opened')], cursor: 'c2' };
      },
    });

    await hub.tick();
    expect(calls).toBe(1);
    expect(store.cursors.get('job-1:0')).toBeUndefined(); // cursor untouched

    await hub.tick();
    expect(calls).toBe(2);
    expect(store.cursors.get('job-1:0')).toBe('c2');
  });

  it('coalesces multiple matched events into ONE fire (bounded batch)', async () => {
    const store = makeStore([makeJob()]);
    const events = [ghEvent('pr-opened', 'acme/widgets', `user${1}`)];
    for (let i = 0; i < 8; i += 1) events.push(ghEvent('pr-opened', 'acme/widgets', `user-${i}`));
    const { hub } = makeHub(store, { pollOverride: async () => ({ events, cursor: 'c2' }) });

    await hub.tick();
    await flush();
    expect(deps.runWake).toHaveBeenCalledTimes(1);
    expect(deps.runWake.mock.calls[0]?.[1]).toContain('ctx=yes');
  });
});

// Keep the trigger type import referenced for readability of fixtures.
const _triggerCheck: RoutineEventTrigger = { type: 'github', repo: 'a/b', events: ['pr-opened'] };
void _triggerCheck;

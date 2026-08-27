/**
 * electron/automation/Scheduler.test.ts
 *
 * Regression tests for the cron scheduler runtime: 60s polling tick fires due
 * jobs, runCronNow returns a handle and executes in the background, and a job
 * pauses itself after retries are exhausted. Execution (agent-run) is mocked;
 * the store is a real CronFileStore over a temp cronjob.toml.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  runCronInSession: vi.fn(),
  createCronSessionRow: vi.fn(),
  resolveCronProvider: vi.fn(),
}));

vi.mock('./agent-run', () => ({
  runCronInSession: mocks.runCronInSession,
  createCronSessionRow: mocks.createCronSessionRow,
  interruptCronSession: vi.fn(),
}));
vi.mock('./provider', () => ({
  resolveCronProvider: mocks.resolveCronProvider,
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    time: vi.fn(),
    timeAsync: vi.fn(),
  }),
  LogComponent: { Automation: 'Automation' },
}));
vi.mock('../db/core-connection', () => ({
  getCoreStores: () => ({ sessions: { get: () => null, create: vi.fn() } }),
}));
vi.mock('./workspace', () => ({
  prepareAutomationWorkspace: (v?: string | null) => v?.trim() || '/tmp/ws',
  resolveAutomationWorkspace: (v?: string | null) => v?.trim() || '/tmp/ws',
}));

import { AutomationScheduler } from './Scheduler';
import { CronFileStore } from './cron-file';
import type { CreateAutomationCronInput } from './types';

let dir: string;
let store: CronFileStore;
let scheduler: AutomationScheduler;

function makeInput(overrides: Record<string, unknown> = {}): CreateAutomationCronInput {
  return {
    name: 'daily report',
    prompt: 'summarize yesterday',
    schedule: { kind: 'every', every: '1m' },
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-test-'));
  store = new CronFileStore(path.join(dir, 'cronjob.toml'));
  scheduler = new AutomationScheduler(store);
  mocks.runCronInSession.mockReset();
  mocks.createCronSessionRow.mockReset();
  mocks.resolveCronProvider.mockReset();
  mocks.resolveCronProvider.mockReturnValue({
    provider: { id: 'p1', apiKey: 'k', baseUrl: 'http://x', providerType: 'openai', options: {} },
    model: 'test-model',
  });
  mocks.runCronInSession.mockResolvedValue({ output: 'ok', events: [] });
});

afterEach(() => {
  scheduler.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AutomationScheduler', () => {
  it('createCron persists to cronjob.toml and listCrons returns it', () => {
    const cron = scheduler.createCron(makeInput());
    expect(cron.id).toBeTruthy();
    expect(scheduler.listCrons()).toHaveLength(1);
    expect(scheduler.getCron(cron.id)?.prompt).toBe('summarize yesterday');
    expect(scheduler.getCron(cron.id)?.enabled).toBe(true);
    expect(fs.existsSync(path.join(dir, 'cronjob.toml'))).toBe(true);
  });

  it('tick fires a job whose next run is due', async () => {
    const cron = scheduler.createCron(makeInput());
    // Force the job to be due: lastRunAt far in the past.
    store.markRunResult(cron.id, { lastRunAt: Date.now() - 5 * 60_000, error: null, retryCount: 0 });
    await scheduler.tick();
    await vi.waitFor(() => expect(mocks.runCronInSession).toHaveBeenCalledTimes(1));
    const updated = scheduler.getCron(cron.id)!;
    expect(updated.lastError).toBeNull();
    expect(updated.retryCount).toBe(0);
  });

  it('tick does not fire a job that is not yet due', async () => {
    scheduler.createCron(makeInput()); // fresh job: next run = now + 1m
    await scheduler.tick();
    expect(mocks.runCronInSession).not.toHaveBeenCalled();
  });

  it('fires a daily-9am cron via the polling tick (regression: cron schedules were silently never firing)', async () => {
    // Regression guard: `computeNextRunAt` used to anchor cron schedules on
    // `nowMs`, and croner.nextRun is strictly-after. Combined with the
    // `nextRunAt <= now` filter, this meant daily/hourly cron jobs never
    // fired through the tick. The fix anchors on `lastRunAt`/`createdAt`;
    // here we simulate an app that has been idle past the scheduled time
    // by setting lastRunAt to yesterday 09:00 — the tick must now detect
    // today's 09:00 as due and fire exactly once.
    const cron = scheduler.createCron(
      makeInput({
        name: 'daily 9am',
        schedule: { kind: 'cron', expr: '0 9 * * *' },
      }),
    );
    // Pretend the previous fire was yesterday at 09:00; today's 09:00 is overdue.
    const yesterday9 = Date.now() - 24 * 3600_000;
    store.markRunResult(cron.id, { lastRunAt: yesterday9, error: null, retryCount: 0 });

    await scheduler.tick();
    await vi.waitFor(() => expect(mocks.runCronInSession).toHaveBeenCalledTimes(1));
  });

  it('fires a freshly-created cron on the next tick after its first scheduled occurrence (regression: first run was unreachable)', async () => {
    // Regression guard for the very-first-run path. We pin `Date.now()` to a
    // known instant so the test is not flaky around the daily 9am boundary:
    // pretend the cron was created at 08:00 UTC and the scheduler is now
    // ticking at 09:00:30 UTC. The next 9am strictly after 08:00 is today
    // 09:00 UTC, which is <= now → the tick filter must fire.
    //
    // Two clock phases are needed: `createCron` writes the on-disk
    // `created_at`, so the mock must be set BEFORE creating the cron and
    // advanced AFTER. Mutating `doc.jobs[i].created_at` directly is racy
    // because `tick()` calls `store.load()` and re-reads from disk.
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      // Phase 1: pretend create time is 08:00 UTC.
      nowSpy.mockReturnValue(Date.UTC(2026, 7, 11, 8, 0, 0));
      const cron = scheduler.createCron(
        makeInput({
          name: 'fresh daily',
          schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' },
        }),
      );

      // Phase 2: advance clock to 09:00:30 UTC — the tick.
      nowSpy.mockReturnValue(Date.UTC(2026, 7, 11, 9, 0, 30));

      const seeded = store.getCron(cron.id)!;
      expect(seeded.nextRunAt).not.toBeNull();
      expect(seeded.nextRunAt!).toBe(Date.UTC(2026, 7, 11, 9, 0, 0));
      expect(seeded.nextRunAt!).toBeLessThanOrEqual(Date.now());

      await scheduler.tick();
      await vi.waitFor(() => expect(mocks.runCronInSession).toHaveBeenCalledTimes(1));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runCronNow returns a handle and executes in the background', async () => {
    const cron = scheduler.createCron(makeInput());
    const handle = await scheduler.runCronNow(cron.id);
    expect(handle.cronId).toBe(cron.id);
    expect(handle.sessionId).toContain(`cron:${cron.id}:`);
    await vi.waitFor(() => expect(mocks.runCronInSession).toHaveBeenCalled());
  });

  it('runCronNow throws for an unknown cron', async () => {
    await expect(scheduler.runCronNow('nope')).rejects.toThrow('cron not found');
  });

  it('records last_error and pauses the job after retries are exhausted', async () => {
    const cron = scheduler.createCron(makeInput({ maxRetries: 1 }));
    mocks.runCronInSession.mockRejectedValue(new Error('boom'));
    store.markRunResult(cron.id, { lastRunAt: Date.now() - 60_000, error: null, retryCount: 0 });
    await scheduler.tick();

    await vi.waitFor(() => {
      const c = scheduler.getCron(cron.id)!;
      expect(c.lastError).toBe('boom');
      expect(c.retryCount).toBe(1);
    });
    await vi.waitFor(() => {
      expect(scheduler.getCron(cron.id)?.enabled).toBe(false);
    });
  });

  it('skips a scheduled run while the same cron is already running (skip policy)', async () => {
    const cron = scheduler.createCron(makeInput({ concurrencyPolicy: 'skip' }));
    store.markRunResult(cron.id, { lastRunAt: Date.now() - 60_000, error: null, retryCount: 0 });
    // Simulate an in-flight run occupying the cron.
    scheduler['running'].set(cron.id, new Set(['cron:x:0:r1']));
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.runCronInSession).not.toHaveBeenCalled();
  });
});

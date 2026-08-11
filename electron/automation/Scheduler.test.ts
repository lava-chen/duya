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

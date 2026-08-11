/**
 * electron/automation/cron-file.test.ts — CronFileStore over a temp cronjob.toml.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CronFileStore, parseCronJobFile } from './cron-file';
import type { CreateAutomationCronInput } from './types';

let dir: string;
let file: string;
let store: CronFileStore;

function makeInput(overrides: Record<string, unknown> = {}): CreateAutomationCronInput {
  return {
    name: 'daily',
    prompt: 'run task',
    schedule: { kind: 'every', every: '1d' },
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-file-test-'));
  file = path.join(dir, 'cronjob.toml');
  store = new CronFileStore(file);
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('CronFileStore', () => {
  it('createCron writes to disk and a fresh store reads it back', () => {
    const cron = store.createCron(makeInput({ schedule: { kind: 'cron', expr: '0 9 * * *' }, model: 'minimax' }));
    expect(cron.id).toBeTruthy();

    const store2 = new CronFileStore(file);
    const read = store2.getCron(cron.id)!;
    expect(read.name).toBe('daily');
    expect(read.model).toBe('minimax');
    expect(read.schedule).toMatchObject({ kind: 'cron', expr: '0 9 * * *' });
    expect(read.enabled).toBe(true);
    expect(read.nextRunAt).toBeTypeOf('number');
  });

  it('updateCron persists changes (enabled, model, schedule)', () => {
    const cron = store.createCron(makeInput());
    const updated = store.updateCron(cron.id, { enabled: false, model: 'new-model' });
    expect(updated.enabled).toBe(false);
    expect(updated.model).toBe('new-model');
    expect(store.getCron(cron.id)!.enabled).toBe(false);

    // persisted across reload
    const read = new CronFileStore(file).getCron(cron.id)!;
    expect(read.enabled).toBe(false);
    expect(read.model).toBe('new-model');
  });

  it('deleteCron removes the definition and is idempotent', () => {
    const cron = store.createCron(makeInput());
    expect(store.deleteCron(cron.id).success).toBe(true);
    expect(store.getCron(cron.id)).toBeNull();
    expect(store.deleteCron(cron.id).success).toBe(false);
  });

  it('markRunResult persists runtime state (last_run_at / last_error / retry_count)', () => {
    const cron = store.createCron(makeInput());
    store.markRunResult(cron.id, { lastRunAt: 123, error: 'boom', retryCount: 2 });
    const read = new CronFileStore(file).getCron(cron.id)!;
    expect(read.lastRunAt).toBe(123);
    expect(read.lastError).toBe('boom');
    expect(read.retryCount).toBe(2);
  });

  it('requires name and prompt', () => {
    expect(() => store.createCron(makeInput({ name: '' }))).toThrow(/name is required/);
    expect(() => store.createCron(makeInput({ prompt: '' }))).toThrow(/prompt is required/);
  });

  it('assigns a stable id to a hand-written job missing one', () => {
    fs.writeFileSync(
      file,
      `version = 1\n\n[[jobs]]\nname = "handwritten"\nprompt = "do it"\nenabled = true\nschedule = { kind = "every", every = "1h" }\n`,
    );
    const s = new CronFileStore(file);
    const cron = s.listCrons()[0];
    expect(cron.id).toBeTruthy();
    // persisted back with the id
    expect(fs.readFileSync(file, 'utf-8')).toContain(`id = "${cron.id}"`);
  });
});

describe('parseCronJobFile', () => {
  it('rejects an unsupported version', () => {
    expect(() => parseCronJobFile('version = 99\n[[jobs]]\n')).toThrow(/unsupported cronjob\.toml version/);
  });

  it('rejects a job missing its prompt', () => {
    expect(() => parseCronJobFile('version = 1\n\n[[jobs]]\nname = "x"\nenabled = true\nschedule = { kind = "every", every = "1h" }\n')).toThrow(/prompt is required/);
  });
});

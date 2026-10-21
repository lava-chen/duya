/**
 * Plan 476 P2.3d — cronjob.toml round-trip with event triggers and
 * listener cursors, plus the optional-schedule rules.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CronFileStore, parseCronJobFile } from '../cron-file.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-cron-triggers-'));
});

describe('CronFileStore — event triggers', () => {
  it('round-trips a github listener (create → load)', () => {
    const filePath = path.join(dir, 'cronjob.toml');
    const store = new CronFileStore(filePath);
    const created = store.createCron({
      name: 'PR watch',
      prompt: 'Report new PRs.',
      agent: 'news-bot',
      eventTriggers: [{ type: 'github', repo: 'acme/widgets', events: ['pr-opened'] }],
    });
    expect(created.schedule).toBeNull();
    expect(created.eventTriggers).toEqual([
      { type: 'github', repo: 'acme/widgets', events: ['pr-opened'] },
    ]);

    const reread = new CronFileStore(filePath);
    const job = reread.getCron(created.id);
    expect(job?.eventTriggers).toEqual([{ type: 'github', repo: 'acme/widgets', events: ['pr-opened'] }]);
    expect(job?.schedule).toBeNull();
    expect(job?.nextRunAt).toBeNull();
  });

  it('round-trips slack listeners and listener cursors', () => {
    const filePath = path.join(dir, 'cronjob.toml');
    const store = new CronFileStore(filePath);
    const created = store.createCron({
      name: 'Mentions',
      prompt: 'Reply to mentions.',
      agent: 'news-bot',
      eventTriggers: [{ type: 'slack', channel: '#eng', match: { kind: 'keyword', keyword: 'deploy' } }],
    });
    expect(store.getListenerCursor(created.id, 0)).toBeNull();
    store.setListenerCursor(created.id, 0, '1700000000.1');

    const reread = new CronFileStore(filePath);
    expect(reread.getListenerCursor(created.id, 0)).toBe('1700000000.1');
    expect(reread.getCron(created.id)?.eventTriggers).toEqual([
      { type: 'slack', channel: '#eng', match: { kind: 'keyword', keyword: 'deploy' } },
    ]);
  });

  it('refuses a job with neither schedule nor triggers', () => {
    const store = new CronFileStore(path.join(dir, 'cronjob.toml'));
    expect(() => store.createCron({ name: 'x', prompt: 'y' })).toThrow('needs a schedule or at least one event trigger');
  });

  it('refuses malformed listener specs', () => {
    const store = new CronFileStore(path.join(dir, 'cronjob.toml'));
    expect(() =>
      store.createCron({
        name: 'x',
        prompt: 'y',
        eventTriggers: [{ type: 'linear', event: 'issueCreated' }],
      }),
    ).toThrow('not recognized');
  });

  it('updateCron replaces the trigger set and can clear it (keeping the schedule)', () => {
    const store = new CronFileStore(path.join(dir, 'cronjob.toml'));
    const created = store.createCron({
      name: 'Hybrid',
      prompt: 'p',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5' },
      eventTriggers: [{ type: 'github', repo: 'acme/w', events: ['pr-opened'] }],
    });
    const replaced = store.updateCron(created.id, {
      eventTriggers: [{ type: 'slack', channel: '*', match: { kind: 'message' } }],
    });
    expect(replaced.eventTriggers).toEqual([{ type: 'slack', channel: '*', match: { kind: 'message' } }]);
    expect(replaced.schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' });

    const cleared = store.updateCron(created.id, { eventTriggers: [] });
    expect(cleared.eventTriggers).toBeUndefined();
    expect(cleared.schedule).toEqual({ kind: 'cron', expr: '0 9 * * 1-5' });
  });

  it('updateCron refuses to strip the last trigger', () => {
    const store = new CronFileStore(path.join(dir, 'cronjob.toml'));
    const created = store.createCron({
      name: 'Event-only',
      prompt: 'p',
      eventTriggers: [{ type: 'github', repo: 'acme/w', events: ['pr-opened'] }],
    });
    expect(() =>
      store.updateCron(created.id, { eventTriggers: [] }),
    ).toThrow('needs a schedule or at least one event trigger');
  });

  it('a job must keep at least one trigger after the update', () => {
    const filePath = path.join(dir, 'cronjob.toml');
    const store = new CronFileStore(filePath);
    const created = store.createCron({
      name: 'Event-only',
      prompt: 'p',
      eventTriggers: [{ type: 'github', repo: 'acme/w', events: ['pr-opened'] }],
    });
    expect(() => store.updateCron(created.id, { eventTriggers: [] })).toThrow();
    void filePath;
  });

  it('parseCronJobFile rejects an event-only job whose listener spec is invalid', () => {
    const text = [
      'version = 1',
      '[[jobs]]',
      'name = "broken"',
      'prompt = "p"',
      'enabled = true',
      '[[jobs.event_triggers]]',
      'type = "github"',
      'repo = "no wildcards *"',
      'events = ["pr-opened"]',
    ].join('\n');
    expect(() => parseCronJobFile(text)).toThrow();
  });

  it('hybrid jobs keep nextRunAt for the schedule half', () => {
    const store = new CronFileStore(path.join(dir, 'cronjob.toml'));
    const created = store.createCron({
      name: 'Hybrid',
      prompt: 'p',
      schedule: { kind: 'every', every: '1h' },
      eventTriggers: [{ type: 'github', repo: 'acme/w', events: ['pr-opened'] }],
    });
    expect(created.nextRunAt).not.toBeNull();
    expect(created.eventTriggers).toHaveLength(1);
  });
});

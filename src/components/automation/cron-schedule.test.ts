import { describe, expect, it } from 'vitest';
import type { AutomationCron } from '@/types/automation';
import {
  createDefaultScheduleDraft,
  draftToSchedule,
  previewNextRun,
  scheduleToDraft,
} from './cron-schedule';

function row(overrides: Partial<AutomationCron>): AutomationCron {
  return {
    id: 'cron-1',
    name: 'Test',
    prompt: 'Run',
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    workingDirectory: '',
    model: 'model',
    enabled: true,
    concurrencyPolicy: 'skip',
    maxRetries: 3,
    lastRunAt: null,
    lastError: null,
    retryCount: 0,
    nextRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('cron schedule adapter', () => {
  it('builds frequency-specific cron expressions', () => {
    const draft = createDefaultScheduleDraft();
    expect(draftToSchedule({ ...draft, preset: 'hourly', minute: 15 })).toMatchObject({ kind: 'cron', expr: '15 * * * *' });
    expect(draftToSchedule({ ...draft, preset: 'weekdays', time: '14:30' })).toMatchObject({ kind: 'cron', expr: '30 14 * * 1-5' });
    expect(draftToSchedule({ ...draft, preset: 'weekly', weekday: 5, time: '14:00' })).toMatchObject({ kind: 'cron', expr: '0 14 * * 5' });
    expect(draftToSchedule({ ...draft, preset: 'monthly', monthDay: 24, time: '09:05' })).toMatchObject({ kind: 'cron', expr: '5 9 24 * *' });
  });

  it('round-trips friendly weekly schedules', () => {
    const draft = scheduleToDraft(row({ schedule: { kind: 'cron', expr: '0 14 * * 5' } }));
    expect(draft).toMatchObject({ preset: 'weekly', weekday: 5, time: '14:00' });
    expect(draftToSchedule(draft)).toMatchObject({ kind: 'cron', expr: '0 14 * * 5' });
  });

  it('preserves an unrecognized expression as custom cron', () => {
    const draft = scheduleToDraft(row({ schedule: { kind: 'cron', expr: '*/7 8-18 * * 1,3,5' } }));
    expect(draft).toMatchObject({ preset: 'custom', customFrequency: 'cron', cronExpr: '*/7 8-18 * * 1,3,5' });
  });

  it('stores and enforces an end-repeat date in previews', () => {
    const now = new Date('2026-07-17T08:00:00');
    const draft = {
      ...createDefaultScheduleDraft(now),
      preset: 'daily' as const,
      time: '09:00',
      endRepeat: 'on' as const,
      endAt: '2026-07-17T08:30',
    };
    expect(previewNextRun(draft, now)).toBeNull();
    expect(draftToSchedule(draft).endAt).toBeTruthy();
  });
});

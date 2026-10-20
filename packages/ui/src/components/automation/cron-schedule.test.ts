import { describe, expect, it } from 'vitest';
import type { AutomationCron } from '@/types/automation';
import {
  createDefaultScheduleDraft,
  cronToEditorDraft,
  draftToSchedule,
  editorDraftToSchedule,
  editorPresetChipLabel,
  previewNextRun,
  scheduleToDraft,
  summarizeEditorDraft,
  timezoneOffsetLabel,
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

describe('cron editor draft (plan 574)', () => {
  function editorRow(overrides: Partial<AutomationCron>): AutomationCron {
    return row(overrides);
  }

  it('round-trips the five fixed presets', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['0 9 * * *', { preset: 'daily', time: '09:00' }],
      ['30 14 * * 1-5', { preset: 'weekdays', time: '14:30' }],
      ['0 14 * * 5', { preset: 'weekly', weekday: 5, time: '14:00' }],
      ['5 9 24 * *', { preset: 'monthly', monthDay: 24, time: '09:05' }],
    ];
    for (const [expr, expected] of cases) {
      const draft = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr } }));
      expect(draft).toMatchObject(expected);
      expect(editorDraftToSchedule(draft)).toMatchObject({ kind: 'cron', expr });
    }
    const hourly = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '15 * * * *' } }));
    expect(hourly).toMatchObject({ preset: 'hourly', minute: 15 });
    expect(editorDraftToSchedule(hourly)).toMatchObject({ kind: 'cron', expr: '15 * * * *' });
  });

  it('maps step expressions onto the structured custom repeat', () => {
    const minute = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '*/5 * * * *' } }));
    expect(minute).toMatchObject({ preset: 'custom', customCount: 5, customUnit: 'minute' });
    expect(editorDraftToSchedule(minute)).toMatchObject({ kind: 'cron', expr: '*/5 * * * *' });

    const hour = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '30 */2 * * *' } }));
    expect(hour).toMatchObject({ preset: 'custom', customCount: 2, customUnit: 'hour' });
    expect(editorDraftToSchedule(hour)).toMatchObject({ kind: 'cron', expr: '30 */2 * * *' });

    const day = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '30 9 */2 * *' } }));
    expect(day).toMatchObject({ preset: 'custom', customCount: 2, customUnit: 'day', time: '09:30' });
    expect(editorDraftToSchedule(day)).toMatchObject({ kind: 'cron', expr: '30 9 */2 * *' });

    expect(editorPresetChipLabel(day)).toBe('每 2 天');
  });

  it('round-trips every-kind intervals through the structured repeat', () => {
    const weekly = cronToEditorDraft(editorRow({ schedule: { kind: 'every', every: '2w' } }));
    expect(weekly).toMatchObject({ preset: 'custom', customCount: 2, customUnit: 'week' });
    expect(editorDraftToSchedule(weekly)).toMatchObject({ kind: 'every', every: '2w' });

    const daily = cronToEditorDraft(editorRow({ schedule: { kind: 'every', every: '3d' } }));
    expect(daily).toMatchObject({ preset: 'custom', customCount: 3, customUnit: 'day' });
    // Day multiples canonicalize to a calendar-anchored cron day step on save
    // (the structured repeat model has no interval semantics for days).
    expect(editorDraftToSchedule(daily)).toMatchObject({ kind: 'cron', expr: '0 9 */3 * *' });
  });

  it('preserves unmappable schedules via rawSchedule until a structured repeat is committed', () => {
    const exotic = cronToEditorDraft(
      editorRow({ schedule: { kind: 'cron', expr: '*/7 8-18 * * 1,3,5' } }),
    );
    expect(exotic).toMatchObject({ preset: 'custom', customCount: 0 });
    expect(exotic.rawSchedule).toMatchObject({ kind: 'cron', expr: '*/7 8-18 * * 1,3,5' });
    expect(editorPresetChipLabel(exotic)).toBe('自定义');
    // A pure open/save cycle must not mangle the stored schedule.
    expect(editorDraftToSchedule(exotic)).toMatchObject({ kind: 'cron', expr: '*/7 8-18 * * 1,3,5' });

    const subMinute = cronToEditorDraft(editorRow({ schedule: { kind: 'every', every: '90m' } }));
    expect(subMinute.rawSchedule).toMatchObject({ kind: 'every', every: '90m' });
    expect(editorDraftToSchedule(subMinute)).toMatchObject({ kind: 'every', every: '90m' });
  });

  it('carries end-repeat and timezone through the editor draft', () => {
    const draft = cronToEditorDraft(
      editorRow({
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai', endAt: '2026-09-30T00:00:00Z' },
      }),
    );
    expect(draft.endRepeat).toBe('on');
    expect(draft.timezone).toBe('Asia/Shanghai');
    const schedule = editorDraftToSchedule(draft);
    expect(schedule.kind === 'cron' && schedule.tz).toBe('Asia/Shanghai');
    expect(schedule.endAt).toBeTruthy();
    // The end date is applied as end-of-day local time on the picked date.
    const end = new Date(schedule.endAt as string);
    expect(end.getHours()).toBe(23);
  });

  it('summarizes drafts for the schedule row', () => {
    const daily = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '0 9 * * *' } }));
    expect(summarizeEditorDraft(daily)).toBe('每天 09:00');
    const weekdays = cronToEditorDraft(editorRow({ schedule: { kind: 'cron', expr: '30 14 * * 1-5' } }));
    expect(summarizeEditorDraft(weekdays)).toBe('每工作日 14:30');
    const every2w = cronToEditorDraft(editorRow({ schedule: { kind: 'every', every: '2w' } }));
    expect(summarizeEditorDraft(every2w)).toBe('每 2 周');
  });

  it('labels the local timezone offset', () => {
    expect(timezoneOffsetLabel('Asia/Shanghai')).toMatch(/^GMT\+8(:00)?$/);
    expect(timezoneOffsetLabel('not-a-zone')).toBe('');
  });
});

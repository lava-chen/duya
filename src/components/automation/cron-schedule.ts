import type { AutomationCron, CronSchedule } from '@/types/automation';

export type SchedulePreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom' | 'once';
export type CustomFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';
export type EndRepeat = 'never' | 'on';

export interface ScheduleDraft {
  preset: SchedulePreset;
  customFrequency: CustomFrequency;
  minute: number;
  time: string;
  weekday: number;
  monthDay: number;
  cronExpr: string;
  timezone: string;
  at: string;
  endRepeat: EndRepeat;
  endAt: string;
}

export const WEEKDAYS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
] as const;

export const PRESET_LABELS: Record<SchedulePreset, string> = {
  hourly: '每小时',
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义',
  once: '仅一次',
};

export const CUSTOM_FREQUENCY_LABELS: Record<CustomFrequency, string> = {
  hourly: '每小时',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  cron: 'Cron 表达式',
};

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function toLocalInput(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoFromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function parseTime(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

function cronParts(expression: string | null | undefined): string[] {
  return expression?.trim().split(/\s+/) ?? [];
}

function normalizedNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function createDefaultScheduleDraft(now = new Date()): ScheduleDraft {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return {
    preset: 'daily',
    customFrequency: 'weekly',
    minute: 0,
    time: '09:00',
    weekday: 1,
    monthDay: 1,
    cronExpr: '0 9 * * 1',
    timezone: systemTimezone(),
    at: toLocalInput(at.toISOString()),
    endRepeat: 'never',
    endAt: '',
  };
}

export function scheduleToDraft(cron: AutomationCron): ScheduleDraft {
  const draft = createDefaultScheduleDraft();
  draft.timezone = cron.schedule_cron_tz || draft.timezone;
  draft.endRepeat = cron.schedule_end_at ? 'on' : 'never';
  draft.endAt = toLocalInput(cron.schedule_end_at);

  if (cron.schedule_kind === 'at') {
    return { ...draft, preset: 'once', at: toLocalInput(cron.schedule_at) };
  }
  if (cron.schedule_kind === 'every') {
    const everyMs = cron.schedule_every_ms ?? 3_600_000;
    if (everyMs === 3_600_000) return { ...draft, preset: 'hourly' };
    return {
      ...draft,
      preset: 'custom',
      customFrequency: 'cron',
      cronExpr: everyMs % 60_000 === 0 ? `*/${Math.max(1, everyMs / 60_000)} * * * *` : cron.schedule_cron_expr || '*/5 * * * *',
    };
  }

  const fields = cronParts(cron.schedule_cron_expr);
  if (fields.length !== 5) {
    return { ...draft, preset: 'custom', customFrequency: 'cron', cronExpr: cron.schedule_cron_expr || '' };
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const numericMinute = Number(minute);
  const numericHour = Number(hour);
  const hasTime = Number.isInteger(numericMinute) && Number.isInteger(numericHour);
  const time = hasTime ? parseTime(hour, minute) : draft.time;

  if (Number.isInteger(numericMinute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { ...draft, preset: 'hourly', minute: normalizedNumber(numericMinute, 0, 59) };
  }
  if (hasTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return { ...draft, preset: 'daily', time };
  }
  if (hasTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return { ...draft, preset: 'weekdays', time };
  }
  if (hasTime && dayOfMonth === '*' && month === '*' && /^[0-7]$/.test(dayOfWeek)) {
    return { ...draft, preset: 'weekly', time, weekday: Number(dayOfWeek) % 7 };
  }
  if (hasTime && /^\d+$/.test(dayOfMonth) && month === '*' && dayOfWeek === '*') {
    return { ...draft, preset: 'monthly', time, monthDay: normalizedNumber(Number(dayOfMonth), 1, 31) };
  }
  return {
    ...draft,
    preset: 'custom',
    customFrequency: 'cron',
    cronExpr: cron.schedule_cron_expr || '',
  };
}

function timeParts(value: string): [number, number] {
  const [hour, minute] = value.split(':').map(Number);
  return [normalizedNumber(hour, 0, 23), normalizedNumber(minute, 0, 59)];
}

function cronForFrequency(
  frequency: Exclude<CustomFrequency, 'cron'> | Exclude<SchedulePreset, 'custom' | 'once' | 'weekdays'>,
  draft: ScheduleDraft,
): string {
  const [hour, minute] = timeParts(draft.time);
  if (frequency === 'hourly') return `${normalizedNumber(draft.minute, 0, 59)} * * * *`;
  if (frequency === 'daily') return `${minute} ${hour} * * *`;
  if (frequency === 'weekly') return `${minute} ${hour} * * ${normalizedNumber(draft.weekday, 0, 6)}`;
  return `${minute} ${hour} ${normalizedNumber(draft.monthDay, 1, 31)} * *`;
}

export function draftToSchedule(draft: ScheduleDraft): CronSchedule {
  const endAt = draft.endRepeat === 'on' ? isoFromLocalInput(draft.endAt) ?? null : null;
  if (draft.preset === 'once') {
    return { kind: 'at', at: isoFromLocalInput(draft.at) };
  }
  if (draft.preset === 'weekdays') {
    const [hour, minute] = timeParts(draft.time);
    return { kind: 'cron', cronExpr: `${minute} ${hour} * * 1-5`, cronTz: draft.timezone || null, endAt };
  }
  if (draft.preset === 'custom') {
    if (draft.customFrequency === 'cron') {
      return { kind: 'cron', cronExpr: draft.cronExpr.trim(), cronTz: draft.timezone || null, endAt };
    }
    return {
      kind: 'cron',
      cronExpr: cronForFrequency(draft.customFrequency, draft),
      cronTz: draft.timezone || null,
      endAt,
    };
  }
  return {
    kind: 'cron',
    cronExpr: cronForFrequency(draft.preset, draft),
    cronTz: draft.timezone || null,
    endAt,
  };
}

export function describeScheduleDraft(draft: ScheduleDraft): string {
  if (draft.preset === 'once') return draft.at ? `仅一次 · ${new Date(draft.at).toLocaleString()}` : '仅一次';
  const period = Number(draft.time.slice(0, 2)) < 12 ? '上午' : '下午';
  if (draft.preset === 'hourly') return `每小时第 ${normalizedNumber(draft.minute, 0, 59)} 分钟`;
  if (draft.preset === 'daily') return `每天 · ${period} ${draft.time}`;
  if (draft.preset === 'weekdays') return `工作日 · ${period} ${draft.time}`;
  if (draft.preset === 'weekly') return `每周${WEEKDAYS.find((item) => item.value === draft.weekday)?.label.slice(1) ?? '一'} · ${draft.time}`;
  if (draft.preset === 'monthly') return `每月 ${draft.monthDay} 日 · ${draft.time}`;
  if (draft.customFrequency === 'cron') return draft.cronExpr || '自定义 Cron';
  return `自定义 · ${CUSTOM_FREQUENCY_LABELS[draft.customFrequency]}`;
}

export function previewNextRun(draft: ScheduleDraft, now = new Date()): Date | null {
  if (draft.preset === 'once') {
    const date = new Date(draft.at);
    return Number.isNaN(date.getTime()) || date <= now ? null : date;
  }
  if (draft.preset === 'custom' && draft.customFrequency === 'cron') return null;
  const next = new Date(now);
  next.setSeconds(0, 0);
  const [hour, minute] = timeParts(draft.time);
  if (draft.preset === 'hourly' || (draft.preset === 'custom' && draft.customFrequency === 'hourly')) {
    next.setMinutes(normalizedNumber(draft.minute, 0, 59), 0, 0);
    if (next <= now) next.setHours(next.getHours() + 1);
  } else if (draft.preset === 'daily' || (draft.preset === 'custom' && draft.customFrequency === 'daily')) {
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  } else if (draft.preset === 'weekdays') {
    next.setHours(hour, minute, 0, 0);
    do {
      if (next > now && next.getDay() >= 1 && next.getDay() <= 5) break;
      next.setDate(next.getDate() + 1);
    } while (true);
  } else if (draft.preset === 'weekly' || (draft.preset === 'custom' && draft.customFrequency === 'weekly')) {
    next.setHours(hour, minute, 0, 0);
    const delta = (draft.weekday - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + delta);
    if (next <= now) next.setDate(next.getDate() + 7);
  } else {
    next.setHours(hour, minute, 0, 0);
    next.setDate(normalizedNumber(draft.monthDay, 1, 31));
    if (next <= now) next.setMonth(next.getMonth() + 1);
  }
  if (draft.endRepeat === 'on') {
    const end = new Date(draft.endAt);
    if (!Number.isNaN(end.getTime()) && next > end) return null;
  }
  return next;
}

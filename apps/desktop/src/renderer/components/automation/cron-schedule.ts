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

function parseEveryDurationSafe(input: string): number | undefined {
  const m = /^(\d+)(s|m|h|d|w)$/.exec(input.trim());
  if (!m) return undefined;
  const unitMs: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Number(m[1]) * unitMs[m[2]];
}

export function scheduleToDraft(cron: AutomationCron): ScheduleDraft {
  const draft = createDefaultScheduleDraft();
  // Event-only routines carry no schedule — return the default draft so
  // read-only callers (row summaries) never dereference null.
  if (cron.schedule == null) return draft;
  const s = cron.schedule;
  draft.timezone = (s.kind === 'cron' && s.tz) || draft.timezone;
  draft.endRepeat = s.endAt ? 'on' : 'never';
  draft.endAt = toLocalInput(s.endAt);

  if (s.kind === 'once') {
    return { ...draft, preset: 'once', at: toLocalInput(s.at) };
  }
  if (s.kind === 'every') {
    const everyMs = parseEveryDurationSafe(s.every) ?? 3_600_000;
    if (everyMs === 3_600_000) return { ...draft, preset: 'hourly' };
    const minutes = everyMs / 60_000;
    const hours = everyMs / 3_600_000;
    let cronExpr: string;
    if (everyMs % 60_000 === 0 && minutes >= 1 && minutes <= 59) {
      cronExpr = `*/${minutes} * * * *`;
    } else if (everyMs % 3_600_000 === 0 && hours >= 1 && hours <= 23) {
      cronExpr = `0 */${hours} * * *`;
    } else {
      cronExpr = '*/5 * * * *';
    }
    return {
      ...draft,
      preset: 'custom',
      customFrequency: 'cron',
      cronExpr,
    };
  }

  const fields = cronParts(s.expr);
  if (fields.length !== 5) {
    return { ...draft, preset: 'custom', customFrequency: 'cron', cronExpr: s.expr || '' };
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
    cronExpr: s.expr || '',
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
    return { kind: 'once', at: isoFromLocalInput(draft.at) ?? '', endAt };
  }
  if (draft.preset === 'weekdays') {
    const [hour, minute] = timeParts(draft.time);
    return { kind: 'cron', expr: `${minute} ${hour} * * 1-5`, tz: draft.timezone || null, endAt };
  }
  if (draft.preset === 'custom') {
    if (draft.customFrequency === 'cron') {
      return { kind: 'cron', expr: draft.cronExpr.trim(), tz: draft.timezone || null, endAt };
    }
    return {
      kind: 'cron',
      expr: cronForFrequency(draft.customFrequency, draft),
      tz: draft.timezone || null,
      endAt,
    };
  }
  return {
    kind: 'cron',
    expr: cronForFrequency(draft.preset, draft),
    tz: draft.timezone || null,
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

// ==================== Cron editor draft (plan 574) ====================
//
// The redesigned cron detail editor uses its own draft type so the legacy
// `ScheduleDraft` (still consumed by bot routines' `CronScheduleCard`) stays
// untouched. The custom repeat is structured as N + unit (分钟/小时/天/周),
// mirroring the 自定义重复 dialog; schedules that don't map onto that model
// are preserved losslessly in `rawSchedule` until the user commits a
// structured repeat.

export type EditorSchedulePreset =
  | 'hourly'
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly'
  | 'custom'
  | 'once';
export type CustomRepeatUnit = 'minute' | 'hour' | 'day' | 'week';

export const EDITOR_PRESET_LABELS: Record<EditorSchedulePreset, string> = {
  hourly: '每小时',
  daily: '每天',
  weekdays: '每工作日',
  weekly: '每周',
  monthly: '每月',
  custom: '自定义',
  once: '仅一次',
};

export const CUSTOM_REPEAT_UNIT_LABELS: Record<CustomRepeatUnit, string> = {
  minute: '分钟',
  hour: '小时',
  day: '天',
  week: '周',
};

export interface CronEditorScheduleDraft {
  preset: EditorSchedulePreset;
  /** HH:MM — full time for daily-ish presets; minute part only for hourly / custom-hour. */
  time: string;
  /** Hourly preset: minute of hour (0-59). */
  minute: number;
  /** Weekly preset: 0=周日 … 6=周六. */
  weekday: number;
  /** Monthly preset: day of month (1-31). */
  monthDay: number;
  /** Once preset: datetime-local value. */
  at: string;
  /** Custom repeat count (>=1 when structured; 0 while a raw schedule is preserved). */
  customCount: number;
  customUnit: CustomRepeatUnit;
  /** Unmappable stored schedule, round-tripped untouched until the user commits a structured repeat. */
  rawSchedule: CronSchedule | null;
  endRepeat: EndRepeat;
  /** End date (YYYY-MM-DD); applied as end-of-day local time. */
  endAt: string;
  timezone: string;
}

export function createCronEditorDraft(now = new Date()): CronEditorScheduleDraft {
  return {
    preset: 'daily',
    time: '09:00',
    minute: 0,
    weekday: 1,
    monthDay: 1,
    at: toLocalInput(nextDayMorning(now).toISOString()),
    customCount: 0,
    customUnit: 'day',
    rawSchedule: null,
    endRepeat: 'never',
    endAt: '',
    timezone: systemTimezone(),
  };
}

function nextDayMorning(now: Date): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at;
}

/** Chip label for the preset dropdown trigger, e.g. "每工作日" / "每 2 天" / "自定义". */
export function editorPresetChipLabel(draft: CronEditorScheduleDraft): string {
  if (draft.preset !== 'custom') return EDITOR_PRESET_LABELS[draft.preset];
  if (draft.rawSchedule || draft.customCount < 1) return EDITOR_PRESET_LABELS.custom;
  return `每 ${draft.customCount} ${CUSTOM_REPEAT_UNIT_LABELS[draft.customUnit]}`;
}

/** "GMT+8"-style label for the schedule row; empty when the zone can't be resolved. */
export function timezoneOffsetLabel(timezone: string): string {
  if (!timezone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function endOfDayIso(dateOnly: string): string | undefined {
  if (!dateOnly) return undefined;
  const date = new Date(`${dateOnly}T23:59:59`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function endAtFromDraft(draft: CronEditorScheduleDraft): string | null {
  return draft.endRepeat === 'on' ? endOfDayIso(draft.endAt) ?? null : null;
}

/** Every-duration → structured N + unit; null when the duration is not representable (<60s or an unclamped step). */
function everyToCustomRepeat(every: string): { count: number; unit: CustomRepeatUnit } | null {
  const ms = parseEveryDurationSafe(every);
  if (ms === undefined || ms < 60_000) return null;
  if (ms % 604_800_000 === 0) return { count: ms / 604_800_000, unit: 'week' };
  if (ms % 86_400_000 === 0) return { count: ms / 86_400_000, unit: 'day' };
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    // A cron hour step only reaches 23 — longer hour multiples land on day steps.
    return hours <= 23 ? { count: hours, unit: 'hour' } : null;
  }
  const minutes = ms / 60_000;
  // A cron minute step only reaches 59 — e.g. "90m" stays raw.
  return minutes <= 59 ? { count: minutes, unit: 'minute' } : null;
}

function numeric(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

function dayOfWeekNumber(value: string): number | null {
  const n = numeric(value);
  return n !== null && n >= 0 && n <= 7 ? n % 7 : null;
}

function stepCount(field: string): number | null {
  const matched = field.match(/^\*\/(\d+)$/);
  return matched ? Number(matched[1]) : null;
}

/**
 * Reverse-map a stored schedule into the editor draft. Schedules outside the
 * structured model (exotic cron fields, sub-minute intervals) set
 * `rawSchedule` and render as a plain "自定义" chip.
 */
export function cronToEditorDraft(cron: AutomationCron): CronEditorScheduleDraft {
  const draft = createCronEditorDraft();
  const s = cron.schedule;
  if (s == null) return draft;
  draft.endRepeat = s.endAt ? 'on' : 'never';
  draft.endAt = toLocalInput(s.endAt).slice(0, 10);
  if (s.kind === 'cron' && s.tz) draft.timezone = s.tz;

  if (s.kind === 'once') {
    return { ...draft, preset: 'once', at: toLocalInput(s.at) };
  }

  if (s.kind === 'every') {
    const repeat = everyToCustomRepeat(s.every);
    if (!repeat) return { ...draft, preset: 'custom', customCount: 0, rawSchedule: s };
    return { ...draft, preset: 'custom', customCount: repeat.count, customUnit: repeat.unit };
  }

  const fields = cronParts(s.expr);
  if (fields.length !== 5) {
    return { ...draft, preset: 'custom', customCount: 0, rawSchedule: s };
  }
  const [minuteF, hourF, dayOfMonthF, monthF, dayOfWeekF] = fields;
  const minute = numeric(minuteF);
  const hour = numeric(hourF);
  const minuteStep = minuteF === '*' ? 1 : stepCount(minuteF);
  const hourStep = stepCount(hourF);
  const dayStep = stepCount(dayOfMonthF);
  const wildcardRest =
    dayOfMonthF === '*' && monthF === '*' && dayOfWeekF === '*';

  // Every minute: `* * * * *` or `*/N * * * *`
  if (minuteStep !== null && wildcardRest) {
    if (minuteStep >= 1 && minuteStep <= 59) {
      return { ...draft, preset: 'custom', customCount: minuteStep, customUnit: 'minute' };
    }
  }
  // Hourly at a fixed minute: `M * * * *`
  if (minute !== null && minute <= 59 && hourF === '*' && wildcardRest) {
    return { ...draft, preset: 'hourly', minute };
  }
  // Every N hours at minute M: `M */N * * *`
  if (minute !== null && minute <= 59 && hourStep !== null && wildcardRest) {
    if (hourStep >= 1 && hourStep <= 23) {
      return {
        ...draft,
        preset: 'custom',
        customCount: hourStep,
        customUnit: 'hour',
        time: `00:${String(minute).padStart(2, '0')}`,
      };
    }
  }
  // Fixed daily/weekly/monthly shapes
  if (minute !== null && hour !== null && minute <= 59 && hour <= 23) {
    const time = parseTime(hourF, minuteF);
    if (wildcardRest) return { ...draft, preset: 'daily', time };
    if (dayOfMonthF === '*' && monthF === '*' && dayOfWeekF === '1-5') {
      return { ...draft, preset: 'weekdays', time };
    }
    if (dayOfMonthF === '*' && monthF === '*') {
      const weekday = dayOfWeekNumber(dayOfWeekF);
      if (weekday !== null) return { ...draft, preset: 'weekly', time, weekday };
    }
    if (monthF === '*' && dayOfWeekF === '*') {
      const monthDay = numeric(dayOfMonthF);
      if (monthDay !== null && monthDay >= 1 && monthDay <= 31) {
        return { ...draft, preset: 'monthly', time, monthDay };
      }
    }
    // Every N days at a fixed time: `M H */N * *`
    if (monthF === '*' && dayOfWeekF === '*' && dayStep !== null) {
      if (dayStep >= 1 && dayStep <= 31) {
        return { ...draft, preset: 'custom', customCount: dayStep, customUnit: 'day', time };
      }
    }
  }
  return { ...draft, preset: 'custom', customCount: 0, rawSchedule: s };
}

/** Build the persisted `CronSchedule` from the editor draft. */
export function editorDraftToSchedule(draft: CronEditorScheduleDraft): CronSchedule {
  const endAt = endAtFromDraft(draft);
  if (draft.preset === 'once') {
    return { kind: 'once', at: isoFromLocalInput(draft.at) ?? '', endAt };
  }
  if (draft.preset === 'custom' && draft.rawSchedule) {
    return { ...draft.rawSchedule, endAt };
  }
  if (draft.preset === 'custom' && draft.customCount >= 1) {
    const [hour, minute] = timeParts(draft.time);
    const count = draft.customCount;
    switch (draft.customUnit) {
      case 'minute':
        return { kind: 'cron', expr: `*/${Math.min(59, count)} * * * *`, tz: draft.timezone || null, endAt };
      case 'hour':
        return { kind: 'cron', expr: `${minute} */${Math.min(23, count)} * * *`, tz: draft.timezone || null, endAt };
      case 'day':
        return { kind: 'cron', expr: `${minute} ${hour} */${Math.min(31, count)} * *`, tz: draft.timezone || null, endAt };
      case 'week':
        return { kind: 'every', every: `${count}w`, endAt };
    }
  }
  if (draft.preset === 'custom') {
    // Legacy custom fields (draft produced outside the new editor dialog).
    const expr = draft.rawSchedule?.kind === 'cron' ? draft.rawSchedule.expr : '0 9 * * *';
    return { kind: 'cron', expr, tz: draft.timezone || null, endAt };
  }
  if (draft.preset === 'weekdays') {
    const [hour, minute] = timeParts(draft.time);
    return { kind: 'cron', expr: `${minute} ${hour} * * 1-5`, tz: draft.timezone || null, endAt };
  }
  const expr = cronForFrequency(draft.preset, {
    time: draft.time,
    minute: draft.minute,
    weekday: draft.weekday,
    monthDay: draft.monthDay,
  } as ScheduleDraft);
  return { kind: 'cron', expr, tz: draft.timezone || null, endAt };
}

/** One-line schedule summary for the editor's schedule row, e.g. "每工作日 09:00". */
export function summarizeEditorDraft(draft: CronEditorScheduleDraft): string {
  if (draft.preset === 'once') {
    return draft.at ? `仅一次 · ${new Date(draft.at).toLocaleString()}` : '仅一次';
  }
  if (draft.preset === 'hourly') return `每小时第 ${normalizedNumber(draft.minute, 0, 59)} 分钟`;
  if (draft.preset === 'daily') return `每天 ${draft.time}`;
  if (draft.preset === 'weekdays') return `每工作日 ${draft.time}`;
  if (draft.preset === 'weekly') {
    const label = WEEKDAYS.find((item) => item.value === draft.weekday)?.label ?? '周一';
    return `每${label} ${draft.time}`;
  }
  if (draft.preset === 'monthly') return `每月 ${normalizedNumber(draft.monthDay, 1, 31)} 日 ${draft.time}`;
  if (draft.rawSchedule) return describeRawSchedule(draft.rawSchedule);
  if (draft.customCount >= 1) {
    switch (draft.customUnit) {
      case 'minute':
        return `每 ${draft.customCount} 分钟`;
      case 'hour':
        return `每 ${draft.customCount} 小时 · 第 ${timeParts(draft.time)[1]} 分`;
      case 'day':
        return `每 ${draft.customCount} 天 ${draft.time}`;
      case 'week':
        return `每 ${draft.customCount} 周`;
    }
  }
  return EDITOR_PRESET_LABELS.custom;
}

function describeRawSchedule(schedule: CronSchedule): string {
  if (schedule.kind === 'once') {
    return schedule.at ? `仅一次 · ${new Date(schedule.at).toLocaleString()}` : '仅一次';
  }
  if (schedule.kind === 'every') return `每 ${schedule.every}`;
  return schedule.expr || '自定义计划';
}

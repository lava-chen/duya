import { useState, useCallback, useRef } from 'react';
import type { CronSchedule, ParsedAutomationConfig } from '@/types/automation';

function extractSchedule(input: string): CronSchedule | null {
  const normalized = input.toLowerCase().trim();

  const minuteMatch = normalized.match(/every (\d+)\s*minutes?/i);
  if (minuteMatch) {
    return { kind: 'every', everyMs: parseInt(minuteMatch[1], 10) * 60000 };
  }

  const hourMatch = normalized.match(/every (\d+)\s*hours?/i);
  if (hourMatch) {
    return { kind: 'every', everyMs: parseInt(hourMatch[1], 10) * 3600000 };
  }

  const everyHourMatch = normalized.match(/every\s*hour/i);
  if (everyHourMatch) {
    return { kind: 'cron', cronExpr: '0 * * * *', cronTz: null };
  }

  const weekdayAtMatch = normalized.match(/every\s*weekday\s*at\s*(\d{1,2}):(\d{2})/i);
  if (weekdayAtMatch) {
    const m = weekdayAtMatch[2];
    const h = weekdayAtMatch[1];
    return { kind: 'cron', cronExpr: `${m} ${h} * * 1-5`, cronTz: null };
  }

  const dayAtMatch = normalized.match(/every\s*day\s*at\s*(\d{1,2}):(\d{2})/i);
  if (dayAtMatch) {
    const m = dayAtMatch[2];
    const h = dayAtMatch[1];
    return { kind: 'cron', cronExpr: `${m} ${h} * * *`, cronTz: null };
  }

  const weekOnMatch = normalized.match(/every\s*week\s*(?:on\s*)?(\w+)\s*(?:at\s*)?(\d{1,2}):(\d{2})/i);
  if (weekOnMatch) {
    const dayName = weekOnMatch[1].toLowerCase();
    const dowMap: Record<string, string> = {
      sunday: '0', monday: '1', tuesday: '2', wednesday: '3', thursday: '4', friday: '5', saturday: '6',
      mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', sun: '0',
    };
    const dow = dowMap[dayName];
    if (dow) {
      const m = weekOnMatch[3];
      const h = weekOnMatch[2];
      return { kind: 'cron', cronExpr: `${m} ${h} * * ${dow}`, cronTz: null };
    }
  }

  const monthOnMatch = normalized.match(/every\s*month\s*on\s*the\s*(\d+).*at\s*(\d{1,2}):(\d{2})/i);
  if (monthOnMatch) {
    const day = monthOnMatch[1];
    const m = monthOnMatch[3];
    const h = monthOnMatch[2];
    return { kind: 'cron', cronExpr: `${m} ${h} ${day} * *`, cronTz: null };
  }

  const atMatch = normalized.match(/at\s*(\d{4}-\d{2}-\d{2})\s*(\d{1,2}):(\d{2})/i);
  if (atMatch) {
    const dateStr = atMatch[1];
    const h = atMatch[2].padStart(2, '0');
    const m = atMatch[3];
    const atDate = new Date(`${dateStr}T${h}:${m}:00`);
    if (!isNaN(atDate.getTime())) {
      return { kind: 'at', at: atDate.toISOString() };
    }
  }

  const tomorrowMatch = normalized.match(/tomorrow\s*at\s*(\d{1,2}):(\d{2})/i);
  if (tomorrowMatch) {
    const h = parseInt(tomorrowMatch[1], 10);
    const m = parseInt(tomorrowMatch[2], 10);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(h, m, 0, 0);
    return { kind: 'at', at: tomorrow.toISOString() };
  }

  return null;
}

function extractProject(input: string): string | undefined {
  const inMatch = input.match(/in\s*\$([a-zA-Z0-9_-]+)/i);
  if (inMatch) return inMatch[1];

  const fromMatch = input.match(/from\s*\$([a-zA-Z0-9_-]+)/i);
  if (fromMatch) return fromMatch[1];

  const dollarMatch = input.match(/\$([a-zA-Z0-9_-]+)/);
  if (dollarMatch) return dollarMatch[1];

  return undefined;
}

function extractName(input: string): string | undefined {
  const firstSentence = input.split(/[.!?]/)[0];
  if (!firstSentence) return undefined;

  const cleanSentence = firstSentence
    .replace(/every\s+(weekday|day|week|month|hour|minute).*/i, '')
    .replace(/at\s+\d{1,2}:\d{2}.*/i, '')
    .replace(/\$\w+/g, '')
    .trim();

  if (cleanSentence.length > 1) {
    return cleanSentence.slice(0, 50);
  }

  return undefined;
}

function cleanPrompt(input: string, schedule: CronSchedule | null): string {
  let cleaned = input;

  if (schedule) {
    if (schedule.kind === 'every') {
      cleaned = cleaned.replace(/every\s+(\d+)\s*(minutes?|hours?)/i, '').trim();
    } else if (schedule.kind === 'cron') {
      cleaned = cleaned
        .replace(/every\s+(weekday|day|week|month|hour)\s*(at\s*\d{1,2}:\d{2})?/i, '')
        .replace(/every\s+week\s*on\s*\w+\s*(at\s*\d{1,2}:\d{2})?/i, '')
        .replace(/every\s+month\s*on\s*the\s*\d+.*?at\s*\d{1,2}:\d{2}/i, '')
        .trim();
    } else if (schedule.kind === 'at') {
      cleaned = cleaned.replace(/at\s+\d{4}-\d{2}-\d{2}\s*\d{1,2}:\d{2}/i, '')
        .replace(/tomorrow\s*at\s*\d{1,2}:\d{2}/i, '')
        .trim();
    }
  }

  cleaned = cleaned.replace(/\$[a-zA-Z0-9_-]+/g, '').trim();

  return cleaned || input.trim();
}

export function parseNaturalLanguage(input: string): ParsedAutomationConfig {
  const schedule = extractSchedule(input);
  const project = extractProject(input);
  const name = extractName(input) || `Automation ${new Date().toLocaleDateString()}`;
  const prompt = cleanPrompt(input, schedule);

  return {
    name,
    prompt,
    schedule: schedule || { kind: 'every', everyMs: 86400000 },
    project,
  };
}

export function useAutomationParser() {
  const [parsed, setParsed] = useState<ParsedAutomationConfig | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const parse = useCallback((input: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    if (!input.trim()) {
      setParsed(null);
      return;
    }

    timerRef.current = setTimeout(() => {
      const result = parseNaturalLanguage(input);
      setParsed(result);
    }, 500);
  }, []);

  return { parsed, parse };
}
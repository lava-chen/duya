/**
 * Calendar connector — Plan 503 P6 (independent provider, separate OAuth consent).
 *
 * Read the primary calendar's upcoming events and create new events. Tokens
 * never leave the main process.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

const PROVIDER = asAppConnectorId('calendar');
const CALENDAR_LIST_ACTION = 'calendar.list';
const CALENDAR_CREATE_ACTION = 'calendar.create';

interface CalendarDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  htmlLink?: string;
}

const listEventsSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Optional search text to match against event title/description.' },
    timeMin: { type: 'string', description: 'ISO-8601 start of window (or "now"). Defaults to now.' },
    timeMax: { type: 'string', description: 'Optional ISO-8601 end of window.' },
    maxResults: { type: 'number', description: 'Max events to return (1-50). Default 10.' },
  },
  required: [],
};

const createEventSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Event title.' },
    description: { type: 'string', description: 'Optional longer description.' },
    location: { type: 'string', description: 'Optional location.' },
    start: { type: 'string', description: 'ISO-8601 start datetime, e.g. 2026-09-10T09:00:00.' },
    end: { type: 'string', description: 'ISO-8601 end datetime. Defaults to start + 1 hour.' },
    timeZone: { type: 'string', description: 'Optional IANA time zone, e.g. America/Los_Angeles. Defaults to UTC.' },
  },
  required: ['summary', 'start'],
};

/** Build the descriptor list for a single connection. */
export function listCalendarDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'calendar_list_events',
      description: 'List upcoming events on the connected Google Calendar within a time window. Read-only.',
      inputSchema: listEventsSchema,
      inputSchemaSummary: 'query?: search text; timeMin?: ISO (default now); timeMax?: ISO; maxResults?: number (1-50, default 10). Returns events with id, title, time, location.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: CALENDAR_LIST_ACTION,
    },
    {
      name: 'calendar_create_event',
      description: 'Create a new event on the connected Google Calendar. This adds a real calendar entry the user can see.',
      inputSchema: createEventSchema,
      inputSchemaSummary: 'summary; start (ISO datetime); end?: ISO datetime (default start + 1h); description?; location?; timeZone? (IANA). Returns the created event.',
      riskTier: 'write',
      provider: PROVIDER,
      connectionId,
      action: CALENDAR_CREATE_ACTION,
    },
  ];
}

async function listCalendarEvents(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const query = stringValue(input.query);
  const timeMin = resolveIso(input.timeMin, new Date().toISOString());
  if (!timeMin) return invalidArguments('timeMin must be an ISO-8601 timestamp or "now"');
  const timeMax = resolveIso(input.timeMax, undefined);
  if (input.timeMax !== undefined && !timeMax) return invalidArguments('timeMax must be an ISO-8601 timestamp');
  const maxResults = clampNumber(input.maxResults, 10, 1, 50);

  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('maxResults', String(maxResults));
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  if (timeMax) url.searchParams.set('timeMax', timeMax);
  if (query) url.searchParams.set('q', query);

  const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return calendarFailure('list events', response.status);
  const data = (await response.json()) as { items?: CalendarEvent[] };
  return {
    success: true,
    data: {
      events: (data.items ?? []).map(toProjectedEvent).filter((event): event is NonNullable<typeof event> => event !== null),
    },
  };
}

async function createCalendarEvent(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const summary = stringValue(input.summary);
  const start = resolveIso(input.start, undefined);
  if (!summary) return invalidArguments('summary is required');
  if (!start) return invalidArguments('start must be an ISO-8601 datetime');
  const timeZone = stringValue(input.timeZone) ?? 'UTC';
  const endValue = resolveIso(input.end, new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString());
  if (input.end !== undefined && !endValue) return invalidArguments('end must be an ISO-8601 datetime');
  if (endValue && new Date(endValue) <= new Date(start)) return invalidArguments('end must be after start');

  const payload: Record<string, unknown> = {
    summary,
    start: { dateTime: start, timeZone },
    end: { dateTime: endValue!, timeZone },
  };
  const description = stringValue(input.description);
  if (description) payload.description = description;
  const location = stringValue(input.location);
  if (location) payload.location = location;

  const response = await fetchImpl('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) return calendarFailure('create event', response.status);
  const created = (await response.json()) as CalendarEvent;
  return { success: true, data: toProjectedEvent(created) ?? { id: created.id, summary: created.summary } };
}

function toProjectedEvent(event: CalendarEvent): {
  id?: string; summary?: string; description?: string; location?: string;
  start?: string; end?: string; htmlLink?: string;
} | null {
  if (!event.id && !event.summary) return null;
  return {
    id: event.id,
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    htmlLink: event.htmlLink,
  };
}

function resolveIso(value: unknown, fallback: string | undefined): string | undefined {
  const raw = stringValue(value);
  if (raw === undefined) return fallback;
  if (raw === 'now') return new Date().toISOString();
  // Naive datetimes (no timezone designator) are floating in Google's model,
  // so treat them as UTC rather than the machine's local zone: append 'Z'
  // before parsing so they round-trip without an unexpected offset.
  const normalized = /[zZ]$|[+-]\d{2}:\d{2}$/.test(raw) ? raw : raw + 'Z';
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function calendarFailure(action: string, status: number): ConnectorInvokeResult {
  return {
    success: false,
    error: { code: 'http_' + status, message: 'Google Calendar ' + action + ' failed: ' + status, retriable: status >= 500 },
  };
}

function invalidArguments(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'invalid_arguments', message, retriable: false } };
}

/** Construct a Calendar connector module bound to a custom fetch (tests). */
export function createCalendarConnector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listCalendarDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === CALENDAR_LIST_ACTION) return listCalendarEvents(args, accessToken, fetchImpl);
      if (action === CALENDAR_CREATE_ACTION) return createCalendarEvent(args, accessToken, fetchImpl);
      return {
        success: false,
        error: { code: 'unknown_action', message: 'Unknown calendar action: ' + action, retriable: false },
      };
    },
  };
}
import { describe, expect, it } from 'vitest';
import { createCalendarConnector, listCalendarDescriptors } from '../connectors/calendar';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Google Calendar connector', () => {
  it('exposes the list and create workflow with correct risk tiers', () => {
    const descriptors = listCalendarDescriptors('calendar-1');
    expect(descriptors.map((d) => d.name)).toEqual(['calendar_list_events', 'calendar_create_event']);
    expect(descriptors[0]!.riskTier).toBe('read');
    expect(descriptors[1]!.riskTier).toBe('write');
  });

  it('lists upcoming events with a bounded maxResults and singleEvents ordering', async () => {
    const urls: string[] = [];
    const connector = createCalendarConnector((async (input) => {
      urls.push(input.toString());
      return jsonResponse({
        items: [{
          id: 'evt-1',
          summary: 'Standup',
          description: 'Daily sync',
          start: { dateTime: '2026-09-07T09:00:00Z' },
          end: { dateTime: '2026-09-07T09:15:00Z' },
          htmlLink: 'https://calendar.google.com/calendar/event?eid=evt-1',
        }],
      });
    }) as typeof fetch);

    const result = await connector.invoke('calendar.list', { query: 'standup', maxResults: 99 }, 'token');

    expect(result.success).toBe(true);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('maxResults')).toBe('50');
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
    expect(url.searchParams.get('q')).toBe('standup');
    expect(url.searchParams.has('timeMin')).toBe(true);
    expect(result).toMatchObject({
      success: true,
      data: {
        events: [{ id: 'evt-1', summary: 'Standup', start: '2026-09-07T09:00:00Z' }],
      },
    });
  });

  it('creates an event and defaults the end time to start + 1 hour in the UTC zone', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = createCalendarConnector((async (input, init) => {
      calls.push({ url: input.toString(), init });
      return jsonResponse({ id: 'evt-2', summary: 'Review', htmlLink: 'https://calendar.google.com/...' });
    }) as typeof fetch);

    const result = await connector.invoke('calendar.create', {
      summary: 'Review',
      start: '2026-09-10T09:00:00',
    }, 'token');

    expect(result.success).toBe(true);
    const sent = calls[0]!;
    expect(sent.url).toContain('/calendars/primary/events');
    expect(sent.init?.method).toBe('POST');
    const payload = JSON.parse(String(sent.init?.body)) as Record<string, unknown>;
    expect(payload.summary).toBe('Review');
    const start = payload.start as { dateTime: string; timeZone: string };
    const end = payload.end as { dateTime: string; timeZone: string };
    expect(start.dateTime).toBe('2026-09-10T09:00:00.000Z');
    expect(end.dateTime).toBe('2026-09-10T10:00:00.000Z');
    expect(start.timeZone).toBe('UTC');
    expect(result).toMatchObject({ success: true, data: { id: 'evt-2', summary: 'Review' } });
  });

  it('rejects invalid create input without posting to the API', async () => {
    const connector = createCalendarConnector((async () => {
      throw new Error('fetch should not be called');
    }) as typeof fetch);

    const missingSummary = await connector.invoke('calendar.create', { start: '2026-09-10T09:00:00' }, 'token');
    expect(missingSummary).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });

    const badWindow = await connector.invoke('calendar.create', {
      summary: 'X',
      start: '2026-09-10T09:00:00',
      end: '2026-09-10T08:00:00',
    }, 'token');
    expect(badWindow).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });
});
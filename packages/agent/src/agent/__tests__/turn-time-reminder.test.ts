/**
 * turn-time-reminder.test.ts — unit contract for the persistent turn
 * timestamp injection (C′).
 *
 * The critical property under test is BYTE DETERMINISM: the same epoch
 * timestamp must always render the same reminder bytes regardless of
 * locale / system timezone, and the version-1 rule must only target
 * human turns (never harness-injected user-role messages).
 */

import { describe, expect, it } from 'vitest';
import {
  buildTurnTimestampReminder,
  formatCanonicalTurnTimestamp,
  injectTurnTimestampReminders,
  isHumanTurnUserMessage,
} from '../turn-time-reminder.js';

describe('formatCanonicalTurnTimestamp', () => {
  it('renders UTC ISO-8601 seconds with millis stripped (locale-free)', () => {
    // 2026-09-28T02:50:31.482Z
    expect(formatCanonicalTurnTimestamp(Date.UTC(2026, 8, 28, 2, 50, 31, 482))).toBe(
      '2026-09-28T02:50:31Z',
    );
  });

  it('floors partial seconds deterministically', () => {
    expect(formatCanonicalTurnTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0, 999))).toBe(
      '2026-01-01T00:00:00Z',
    );
  });
});

describe('buildTurnTimestampReminder', () => {
  it('emits the locked v1 envelope bytes', () => {
    const reminder = buildTurnTimestampReminder(Date.UTC(2026, 8, 28, 2, 50, 31));
    expect(reminder).toBe(
      '<system-reminder>\nMessage sent at 2026-09-28T02:50:31Z.\n</system-reminder>',
    );
  });
});

describe('isHumanTurnUserMessage', () => {
  const base = { role: 'user', content: 'hello', timestamp: 1759000000000 };

  it('targets plain human turns', () => {
    expect(isHumanTurnUserMessage(base)).toBe(true);
  });

  it('excludes harness injections', () => {
    expect(isHumanTurnUserMessage({ ...base, source: 'system' })).toBe(false);
    expect(isHumanTurnUserMessage({ ...base, metadata: { runtimeContext: true } })).toBe(false);
    expect(isHumanTurnUserMessage({ ...base, isCompactSummary: true })).toBe(false);
    expect(isHumanTurnUserMessage({ ...base, compactBoundaryId: 'c-1' })).toBe(false);
  });

  it('excludes synthetic tool_result carriers and missing/epoch-0 timestamps', () => {
    expect(
      isHumanTurnUserMessage({
        ...base,
        content: [{ type: 'tool_result', tool_use_id: 'tu-1' }],
      } as never),
    ).toBe(false);
    expect(isHumanTurnUserMessage({ ...base, timestamp: undefined })).toBe(false);
    expect(isHumanTurnUserMessage({ ...base, timestamp: 0 })).toBe(false);
  });
});

describe('injectTurnTimestampReminders', () => {
  it('appends the reminder to human turns and never mutates the source objects', () => {
    const durable = {
      id: 'u-1',
      role: 'user',
      content: 'original prompt',
      timestamp: Date.UTC(2026, 8, 28, 2, 50, 31),
    };
    const projected: Array<Record<string, unknown>> = [
      { ...durable, content: durable.content },
    ];

    const count = injectTurnTimestampReminders(projected as never);

    expect(count).toBe(1);
    // Projected copy carries the reminder.
    expect(String((projected[0] as { content: string }).content)).toBe(
      'original prompt\n\n<system-reminder>\nMessage sent at 2026-09-28T02:50:31Z.\n</system-reminder>',
    );
    // Durable source object untouched.
    expect(durable.content).toBe('original prompt');
  });

  it('appends a text block for array content without touching the source array', () => {
    const source = {
      id: 'u-2',
      role: 'user',
      content: [{ type: 'text', text: 'with image' }],
      timestamp: Date.UTC(2026, 8, 28, 2, 50, 31),
    };
    const projected = [source];

    injectTurnTimestampReminders(projected as never);

    const content = (projected[0] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content).toHaveLength(2);
    expect(content[1].text).toContain('Message sent at ');
    expect(source.content).toHaveLength(1);
  });

  it('leaves harness-injected messages untouched', () => {
    const messages = [
      { id: 's-1', role: 'user', content: 'wake prompt', source: 'system', timestamp: 1759000000000 },
      {
        id: 'c-1',
        role: 'user',
        content: 'continuation summary',
        isCompactSummary: true,
        timestamp: 1759000000000,
      },
    ];

    expect(injectTurnTimestampReminders(messages as never)).toBe(0);
    expect(String(messages[0].content)).toBe('wake prompt');
    expect(String(messages[1].content)).toBe('continuation summary');
  });
});

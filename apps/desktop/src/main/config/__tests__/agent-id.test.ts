import { describe, it, expect } from 'vitest';
import { isSafeBotId, assertValidBotId, findInvalidBotIds } from '../agent-id';

describe('isSafeBotId (Plan 485 P1.2)', () => {
  it('accepts kebab-case slugs', () => {
    expect(isSafeBotId('frontend-expert')).toBe(true);
    expect(isSafeBotId('alpha')).toBe(true);
    expect(isSafeBotId('bot-007')).toBe(true);
    expect(isSafeBotId('a')).toBe(true);
    expect(isSafeBotId('z'.repeat(63))).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isSafeBotId('..')).toBe(false);
    expect(isSafeBotId('../etc')).toBe(false);
    expect(isSafeBotId('a/b')).toBe(false);
    expect(isSafeBotId('a\\b')).toBe(false);
    expect(isSafeBotId('.')).toBe(false);
    expect(isSafeBotId('/etc/passwd')).toBe(false);
  });

  it('rejects non-conforming characters', () => {
    expect(isSafeBotId('Alpha')).toBe(false); // uppercase
    expect(isSafeBotId('under_score')).toBe(false); // underscore
    expect(isSafeBotId('has.dot')).toBe(false); // dot
    expect(isSafeBotId('a b')).toBe(false); // space
    expect(isSafeBotId(' a')).toBe(false); // leading space
    expect(isSafeBotId('a ')).toBe(false); // trailing space
    expect(isSafeBotId('')).toBe(false);
    expect(isSafeBotId('-lead')).toBe(false); // must start alnum
    expect(isSafeBotId('z'.repeat(64))).toBe(false); // >63 chars
  });

  it('rejects non-string values', () => {
    expect(isSafeBotId(123)).toBe(false);
    expect(isSafeBotId(null)).toBe(false);
    expect(isSafeBotId(undefined)).toBe(false);
  });
});

describe('assertValidBotId', () => {
  it('throws for invalid ids', () => {
    expect(() => assertValidBotId('../etc')).toThrow(/Invalid bot id/);
    expect(() => assertValidBotId('UPPER')).toThrow(/kebab-case/);
  });

  it('does not throw for valid ids', () => {
    expect(() => assertValidBotId('frontend-expert')).not.toThrow();
  });
});

describe('findInvalidBotIds (config scan, warn-only)', () => {
  it('reports offending keys without throwing', () => {
    expect(findInvalidBotIds(['ok-bot', 'Bad_Bot', 'x/y', 42])).toEqual(['Bad_Bot', 'x/y', '42']);
  });

  it('returns empty when all ids are safe', () => {
    expect(findInvalidBotIds(['a', 'b-c', 'd1'])).toEqual([]);
    expect(findInvalidBotIds([])).toEqual([]);
  });
});

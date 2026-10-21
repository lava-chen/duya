/**
 * packages/ai/test/json-repair.test.ts
 *
 * Plan 418 — lenient JSON parsing ported from pi. Some Anthropic-compatible
 * endpoints (DeepSeek /anthropic) emit SSE data: frames whose string literals
 * contain raw control characters or invalid escapes; repairJson fixes the
 * common cases so the frame survives with content intact.
 */

import { describe, it, expect } from 'vitest';
import { repairJson, parseJsonWithRepair } from '../src/utils/json-repair.js';

describe('repairJson', () => {
  it('escapes raw newlines inside string literals', () => {
    const input = '{"type":"content_block_delta","delta":{"type":"text_delta","text":"line1\nline2"}}';
    const repaired = repairJson(input);
    expect(repaired).toContain('line1\\nline2');
    expect(JSON.parse(repaired)).toEqual({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'line1\nline2' },
    });
  });

  it('escapes raw tabs and carriage returns inside strings', () => {
    const repaired = repairJson('{"text":"a\tb"}');
    expect(JSON.parse(repaired)).toEqual({ text: 'a\tb' });
    const repairedCr = repairJson('{"text":"a\rb"}');
    expect(JSON.parse(repairedCr)).toEqual({ text: 'a\rb' });
  });

  it('doubles backslashes before invalid escapes', () => {
    // A lone backslash before 'x' (not a valid JSON escape) is doubled.
    const input = '{"text":"c:\\x\\Users"}';
    const repaired = repairJson(input);
    expect(repaired).toContain('c:\\\\x\\\\Users');
    expect(JSON.parse(repaired)).toEqual({ text: 'c:\\x\\Users' });
  });

  it('preserves valid escapes including unicode sequences', () => {
    const input = '{"text":"\\u4f60\\n\\t\\\\"}';
    expect(repairJson(input)).toBe(input);
  });

  it('escapes other control characters as \\u00XX', () => {
    const repaired = repairJson('{"text":"a\u0001b"}');
    expect(repaired).toContain('\\u0001');
    expect(JSON.parse(repaired)).toEqual({ text: 'a\u0001b' });
  });

  it('leaves valid JSON untouched', () => {
    const valid = '{"type":"message_stop"}';
    expect(repairJson(valid)).toBe(valid);
  });
});

describe('parseJsonWithRepair', () => {
  it('parses valid JSON directly', () => {
    expect(parseJsonWithRepair('{"type":"message_stop"}')).toEqual({ type: 'message_stop' });
  });

  it('repairs and parses malformed frames', () => {
    const out = parseJsonWithRepair(
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi\nnext"}}',
    ) as { delta: { text: string } };
    expect(out.delta.text).toBe('hi\nnext');
  });

  it('returns null when the frame cannot be repaired', () => {
    expect(parseJsonWithRepair('this is {not] valid json')).toBeNull();
    expect(parseJsonWithRepair('{"unterminated')).toBeNull();
    expect(parseJsonWithRepair('')).toBeNull();
  });
});

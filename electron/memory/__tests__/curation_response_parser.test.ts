import { describe, it, expect } from 'vitest';

import {
  CurationResponseSchema,
  extractFirstJsonObject,
  parseCurationResponse,
  CurationParseError,
} from '../curation_response_parser';

const VALID = JSON.stringify({
  decisions: [
    { rollout_id: 'r-1', disposition: 'absorbed', reason: 'rule' },
    { rollout_id: 'r-2', disposition: 'no_signal', reason: 'noise' },
  ],
  actions: [
    {
      op: 'append',
      area_path: 'global/areas/foo.md',
      content: '## rule\n- never lie',
      reason: 'r-1 confirmed',
    },
    {
      op: 'no_op',
      area_path: 'global/areas/foo.md',
      content: '',
      reason: 'r-2 is empty',
    },
  ],
});

describe('extractFirstJsonObject', () => {
  it('1. bare JSON object', () => {
    expect(extractFirstJsonObject(VALID)).toBe(VALID);
  });

  it('2. markdown fence ```json ... ```', () => {
    const fenced = '```json\n' + VALID + '\n```';
    expect(extractFirstJsonObject(fenced)).toBe(VALID);
  });

  it('3. preamble + JSON', () => {
    const preamble = 'Here is the curation result:\n' + VALID;
    expect(extractFirstJsonObject(preamble)).toBe(VALID);
  });

  it('4. no JSON object → null', () => {
    expect(extractFirstJsonObject('no json here')).toBe(null);
  });

  it('5. unbalanced braces → null', () => {
    expect(extractFirstJsonObject('{"a": 1, "c": ')).toBe(null);
  });

  it('6. brace inside string is preserved, then closed', () => {
    const text = JSON.stringify({ x: '{not json}' }) + '}'; // extra }
    // The first '{' opens, finds '}' inside the string then continues;
    // wait — the implementation does NOT track strings inside JSON via
    // the regex pass. Verify the brace-in-string edge case behaviour:
    const result = extractFirstJsonObject('{"x":"}"}');
    // First '{' at 0, hits '"' at 4 (inString=true), hits '}' at 6 still inString,
    // hits '"' at 7 (inString=false), hits '}' at 8 (depth=0). Returns.
    expect(result).toBe('{"x":"}"}');
  });
});

describe('parseCurationResponse — happy paths', () => {
  it('1. parses the canonical VALID blob', () => {
    const result = parseCurationResponse(VALID);
    expect(result.decisions).toHaveLength(2);
    expect(result.actions).toHaveLength(2);
  });

  it('2. parses fence-wrapped JSON', () => {
    const result = parseCurationResponse('```json\n' + VALID + '\n```');
    expect(result.actions[0].op).toBe('append');
  });

  it('3. parses preamble-wrapped JSON', () => {
    const result = parseCurationResponse('Done.\n' + VALID);
    expect(result.decisions[0].rollout_id).toBe('r-1');
  });
});

describe('parseCurationResponse — failure modes', () => {
  it('4. empty string', () => {
    expect(() => parseCurationResponse('')).toThrow(CurationParseError);
  });

  it('5. no JSON object', () => {
    expect(() => parseCurationResponse('hello world')).toThrow(CurationParseError);
  });

  it('6. JSON.parse fails (trailing comma)', () => {
    const bad = '{"decisions": [], "actions": [],}';
    expect(() => parseCurationResponse(bad)).toThrow(CurationParseError);
  });

  it('7. schema violation: missing decisions', () => {
    const bad = JSON.stringify({ actions: [] });
    expect(() => parseCurationResponse(bad)).toThrow(CurationParseError);
  });

  it('8. schema violation: bogus disposition', () => {
    const bad = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'maybe', reason: 'r' }],
      actions: [],
    });
    expect(() => parseCurationResponse(bad)).toThrow(CurationParseError);
  });

  it('9. schema violation: bogus area_path (path traversal)', () => {
    const bad = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{ op: 'append', area_path: '../../../etc/passwd', content: 'x', reason: 'r' }],
    });
    expect(() => parseCurationResponse(bad)).toThrow(CurationParseError);
  });

  it('10. schema violation: append with empty content', () => {
    const bad = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{ op: 'append', area_path: 'global/areas/foo.md', content: '', reason: 'r' }],
    });
    expect(() => parseCurationResponse(bad)).toThrow(CurationParseError);
  });

  it('11. schema violation: no_op with content is fine', () => {
    const ok = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'no_signal', reason: 'r' }],
      actions: [{ op: 'no_op', area_path: 'global/areas/foo.md', content: 'any', reason: 'r' }],
    });
    expect(() => parseCurationResponse(ok)).not.toThrow();
  });
});

describe('CurationResponseSchema — direct', () => {
  it('12. validates decisions + actions shape', () => {
    const result = CurationResponseSchema.safeParse(JSON.parse(VALID));
    expect(result.success).toBe(true);
  });

  it('13. caps decisions at 20', () => {
    const tooMany = {
      decisions: Array.from({ length: 25 }, (_, i) => ({
        rollout_id: `r-${i}`,
        disposition: 'absorbed',
        reason: 'r',
      })),
      actions: [],
    };
    const result = CurationResponseSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });
});
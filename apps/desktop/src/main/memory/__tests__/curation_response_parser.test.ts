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

  it('3a. over-long policy-edit reason is truncated (<=200), run still parses', () => {
    const longReason = 'x'.repeat(500);
    const blob = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        reason: longReason,
        edits: [
          {
            op: 'upsert_rule',
            section: 'S1',
            rule_id: 'no-over-long-reasons',
            text: 'keep reasons short',
            reason: longReason,
          },
        ],
      },
    });
    // Must NOT throw — this is the 19.jsonl recurring failure.
    const result = parseCurationResponse(blob);
    expect(result.stage1_policy?.edits?.[0].reason).toHaveLength(200);
    expect(result.stage1_policy?.reason).toHaveLength(500);
  });

  it('3b. over-long decision/action reasons are truncated (<=500), run still parses', () => {
    const longReason = 'y'.repeat(900);
    const blob = JSON.stringify({
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: longReason }],
      actions: [
        { op: 'append', area_path: 'global/areas/foo.md', content: 'c', reason: longReason },
      ],
    });
    const result = parseCurationResponse(blob);
    expect(result.decisions[0].reason).toHaveLength(500);
    expect(result.actions[0].reason).toHaveLength(500);
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

  it('14. stage1_policy.edit with edits+reason validates', () => {
    const withPolicy = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        edits: [
          { op: 'upsert_rule', section: 'S2', rule_id: 'stated-goals', text: 'capture when the user states a goal', reason: 'goals missing from summaries' },
        ],
        reason: 'user keeps discussing plans; summaries miss them',
      },
    };
    const result = CurationResponseSchema.safeParse(withPolicy);
    expect(result.success).toBe(true);
  });

  it('15. stage1_policy.edit without edits is rejected', () => {
    const bad = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: { op: 'edit', reason: 'no edits' },
    };
    const result = CurationResponseSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('15b. more than 3 edits per run is rejected', () => {
    const tooMany = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        edits: [1, 2, 3, 4].map((i) => ({ op: 'upsert_rule', section: 'S1', rule_id: `r-${i}`, text: 'x', reason: 'y' })),
        reason: 'z',
      },
    };
    const result = CurationResponseSchema.safeParse(tooMany);
    expect(result.success).toBe(false);
  });

  it('15c. upsert_rule without text is rejected; bad section/rule_id rejected', () => {
    const noText = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        edits: [{ op: 'upsert_rule', section: 'S1', rule_id: 'x', reason: 'y' }],
        reason: 'z',
      },
    };
    expect(CurationResponseSchema.safeParse(noText).success).toBe(false);

    const badSection = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        edits: [{ op: 'upsert_rule', section: 'S99', rule_id: 'x', text: 't', reason: 'y' }],
        reason: 'z',
      },
    };
    expect(CurationResponseSchema.safeParse(badSection).success).toBe(false);

    const badId = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      stage1_policy: {
        op: 'edit',
        edits: [{ op: 'remove_rule', section: 'S1', rule_id: 'UPPER-Case', reason: 'y' }],
        reason: 'z',
      },
    };
    expect(CurationResponseSchema.safeParse(badId).success).toBe(false);
  });

  it('16. stage1_policy.no_change without edits validates', () => {
    const ok = {
      decisions: [{ rollout_id: 'r-1', disposition: 'no_signal', reason: 'r' }],
      actions: [],
      stage1_policy: { op: 'no_change' },
    };
    const result = CurationResponseSchema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it('17. new_categories with a valid lowercase name validates', () => {
    const ok = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{ op: 'append', area_path: 'global/lessons/math.md', content: '## x\n- y', reason: 'r' }],
      new_categories: [{ name: 'lessons', reason: 'user activity is mostly coursework across many sessions' }],
    };
    const result = CurationResponseSchema.safeParse(ok);
    expect(result.success).toBe(true);
  });

  it('18. new_categories with invalid name (uppercase/space) is rejected', () => {
    const bad = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      new_categories: [{ name: 'Lessons 101', reason: 'x'.repeat(20) }],
    };
    const result = CurationResponseSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('19. more than one new_category is rejected', () => {
    const bad = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [],
      new_categories: [
        { name: 'lessons', reason: 'a'.repeat(20) },
        { name: 'company', reason: 'b'.repeat(20) },
      ],
    };
    const result = CurationResponseSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('20. action targeting a new category path validates (regex allows it)', () => {
    const ok = {
      decisions: [{ rollout_id: 'r-1', disposition: 'absorbed', reason: 'r' }],
      actions: [{ op: 'append', area_path: 'global/lessons/math-101.md', content: '## x\n- y', reason: 'r' }],
    };
    const result = CurationResponseSchema.safeParse(ok);
    expect(result.success).toBe(true);
  });
});
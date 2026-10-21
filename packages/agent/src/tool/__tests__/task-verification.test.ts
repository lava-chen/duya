/**
 * task-verification tests (plan 554): strict VERDICT parsing, the prompt
 * contract, file-change diffing, and the parent-report builder.
 */

import { describe, it, expect } from 'vitest';
import {
  VERDICT_CONTRACT,
  buildSubagentParentReport,
  diffFileChanges,
  parseModelVerdict,
  wantsVerdictContract,
} from '../task-verification.js';

describe('parseModelVerdict (strict grammar)', () => {
  it('accepts exactly one well-formed verdict line', () => {
    expect(parseModelVerdict('Work done.\n\nVERDICT: PASS')).toBe('pass');
    expect(parseModelVerdict('Could not finish.\nVERDICT: FAIL')).toBe('fail');
    expect(parseModelVerdict('Half done\nverdict: partial')).toBe('partial');
  });

  it('tolerates surrounding whitespace on the line', () => {
    expect(parseModelVerdict('done\n  VERDICT:  PASS  ')).toBe('pass');
  });

  it('rejects decorated or malformed verdicts', () => {
    expect(parseModelVerdict('**VERDICT: PASS**')).toBeUndefined();
    expect(parseModelVerdict('VERDICT: PASS!')).toBeUndefined();
    expect(parseModelVerdict('VERDICT: pass.')).toBeUndefined();
    expect(parseModelVerdict('- VERDICT: FAIL')).toBeUndefined();
  });

  it('rejects zero or multiple verdict lines', () => {
    expect(parseModelVerdict('no verdict here')).toBeUndefined();
    expect(parseModelVerdict('')).toBeUndefined();
    expect(parseModelVerdict(undefined)).toBeUndefined();
    expect(parseModelVerdict('VERDICT: PASS\nVERDICT: FAIL')).toBeUndefined();
  });
});

describe('VERDICT contract', () => {
  it('work agents get the contract, read-only explorers do not', () => {
    expect(wantsVerdictContract('general-purpose')).toBe(true);
    expect(wantsVerdictContract('verification')).toBe(true);
    expect(wantsVerdictContract('Explore')).toBe(false);
    expect(wantsVerdictContract('plan')).toBe(false);
  });

  it('the contract names all three tokens and the exact format', () => {
    expect(VERDICT_CONTRACT).toContain('VERDICT: PASS');
    expect(VERDICT_CONTRACT).toContain('VERDICT: FAIL');
    expect(VERDICT_CONTRACT).toContain('VERDICT: PARTIAL');
    expect(VERDICT_CONTRACT).toContain('no markdown');
  });
});

describe('file-change observation', () => {
  it('diffs porcelain snapshots into added/removed', () => {
    const diff = diffFileChanges(
      [' M src/a.ts', '?? src/old.ts'],
      [' M src/a.ts', '?? src/new.ts'],
    );
    expect(diff).toEqual({
      added: ['?? src/new.ts'],
      removed: ['?? src/old.ts'],
    });
  });

  it('no churn yields empty lists; missing snapshots yield undefined', () => {
    expect(diffFileChanges([' M a'], [' M a'])).toEqual({ added: [], removed: [] });
    expect(diffFileChanges(undefined, [' M a'])).toBeUndefined();
    expect(diffFileChanges([' M a'], undefined)).toBeUndefined();
  });

  it('the parent report renders verdict and bounded changes', () => {
    const report = buildSubagentParentReport({
      verdict: 'pass',
      fileChange: {
        added: ['?? src/new.ts', '?? src/other.ts'],
        removed: [' D src/gone.ts'],
      },
    });
    expect(report).toContain('model_verdict: pass');
    expect(report).toContain('3 entries (+2 / -1)');
    expect(report).toContain('?? src/new.ts');
    expect(report).toContain('best-effort observation, not a sandbox');
  });

  it('a report with nothing to say still states the verdict', () => {
    const report = buildSubagentParentReport({});
    expect(report).toBe('model_verdict: none');
  });
});

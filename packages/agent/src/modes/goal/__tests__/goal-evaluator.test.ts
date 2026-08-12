/**
 * Goal evaluator tests (plan 411 Phase 2) — pure parts.
 *
 * `parseVerifierReport` and `buildVerifierPrompt` are pure and exhaustively
 * tested here. `verifyGoalCompletion` runs a real sub-agent, so its wiring
 * is exercised via mock in `verifyGoalCompletion` tests below (agent
 * discovery + degraded paths), with the actual runAgent call stubbed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseVerifierReport,
  buildVerifierPrompt,
  findVerificationAgent,
  verifyGoalCompletion,
  aggregateSkepticVerdicts,
  mergeGaps,
  fingerprintOf,
} from '../goal-evaluator.js';
import { GoalTracker } from '../goal-tracker.js';

describe('parseVerifierReport', () => {
  it('maps VERDICT: PASS to achieved', () => {
    const r = parseVerifierReport('Build passed.\nVERDICT: PASS');
    expect(r.verdict).toBe('achieved');
  });

  it('maps VERDICT: FAIL to not_achieved with gaps', () => {
    const r = parseVerifierReport(
      ['### Check: tests', '**Command run:** npm test', '**Result: FAIL**', '2 tests failing', 'VERDICT: FAIL'].join('\n'),
    );
    expect(r.verdict).toBe('not_achieved');
    expect(r.gapsSummary).toContain('tests');
    expect(r.gapFingerprint).toBeTruthy();
  });

  it('maps VERDICT: PARTIAL to blocked', () => {
    const r = parseVerifierReport('No test framework available.\nVERDICT: PARTIAL');
    expect(r.verdict).toBe('blocked');
  });

  it('treats a missing marker conservatively as not_achieved', () => {
    const r = parseVerifierReport('some report without a verdict line');
    expect(r.verdict).toBe('not_achieved');
    expect(r.gapsSummary).toBeTruthy();
  });

  it('finds the verdict marker anywhere in the last lines', () => {
    const r = parseVerifierReport('prefix\nVERDICT: FAIL\ntrailing garbage');
    expect(r.verdict).toBe('not_achieved');
  });
});

describe('parseVerifierReport — structured JSON verdict (grok SkepticVerdict)', () => {
  it('parses a well-formed JSON verdict object (fenced or bare)', () => {
    const bare = parseVerifierReport('{"refuted": false, "evidence": "build+ tests green"}');
    expect(bare.verdict).toBe('achieved');

    const fenced = parseVerifierReport(
      'checks done\n```json\n{"refuted": true, "evidence": "2 tests red", "findings": [{"kind": "bug", "location": "src/a.ts:10", "detail": "null deref"}]}\n```',
    );
    expect(fenced.verdict).toBe('not_achieved');
    expect(fenced.gapsSummary).toContain('2 tests red');
    expect(fenced.gapFingerprint).toBeTruthy();
  });

  it('maps blocking=contradiction/unverifiable to blocked', () => {
    const c = parseVerifierReport(
      '{"refuted": true, "evidence": "objective contradicts plan", "blocking": "contradiction"}',
    );
    expect(c.verdict).toBe('blocked');
    const u = parseVerifierReport(
      '{"refuted": true, "evidence": "cannot verify in this env", "blocking": "unverifiable"}',
    );
    expect(u.verdict).toBe('blocked');
  });

  it('ignores a JSON object without a boolean refuted (falls back to text)', () => {
    const r = parseVerifierReport('{"note": "no verdict here"}\nVERDICT: PASS');
    expect(r.verdict).toBe('achieved');
  });

  it('is immune to prose braces before the verdict JSON (bugfix)', () => {
    const r = parseVerifierReport(
      'Result: {FAILED} because of the flaky test. Then: {"refuted": true, "evidence": "tests red"}',
    );
    expect(r.verdict).toBe('not_achieved');
    expect(r.gapsSummary).toContain('tests red');
  });

  it('bracket-balances nested findings so the outer object closes correctly', () => {
    const r = parseVerifierReport(
      '{"refuted": true, "evidence": "x", "findings": [{"kind": "bug", "location": "a.ts:1", "detail": "d"}]}',
    );
    expect(r.verdict).toBe('not_achieved');
    expect(r.gapsSummary).toContain('x');
  });
});

describe('buildVerifierPrompt', () => {
  it('includes objective, summary, and optional baseline/plan', () => {
    const p = buildVerifierPrompt({
      objective: 'Migrate auth',
      finalSummary: 'Done.',
      baselineCommit: 'abc123',
      planFile: 'plan.md',
    });
    expect(p).toContain('Migrate auth');
    expect(p).toContain('Done.');
    expect(p).toContain('abc123');
    expect(p).toContain('plan.md');
    expect(p).toContain('"refuted"');
    expect(p).toContain('"findings"');
  });
});

describe('findVerificationAgent', () => {
  it('finds the verification agent case-insensitively', () => {
    const defs = [
      { agentType: 'Explore', whenToUse: 'x' },
      { agentType: 'verification', whenToUse: 'y' },
    ] as never[];
    expect(findVerificationAgent(defs)?.agentType).toBe('verification');
  });

  it('returns undefined when absent', () => {
    const defs = [{ agentType: 'Explore', whenToUse: 'x' }] as never[];
    expect(findVerificationAgent(defs)).toBeUndefined();
    expect(findVerificationAgent(undefined)).toBeUndefined();
  });
});

describe('aggregateSkepticVerdicts (Phase 3 panel)', () => {
  it('any FAIL → not_achieved even with PASSes', () => {
    const r = aggregateSkepticVerdicts([
      { skeptic: 0, verdict: 'achieved' },
      { skeptic: 1, verdict: 'not_achieved' },
      { skeptic: 2, verdict: 'achieved' },
    ]);
    expect(r).toBe('not_achieved');
  });

  it('no FAIL, any PARTIAL → blocked', () => {
    const r = aggregateSkepticVerdicts([
      { skeptic: 0, verdict: 'achieved' },
      { skeptic: 1, verdict: 'blocked' },
    ]);
    expect(r).toBe('blocked');
  });

  it('all PASS → achieved; empty panel → achieved', () => {
    expect(
      aggregateSkepticVerdicts([
        { skeptic: 0, verdict: 'achieved' },
        { skeptic: 1, verdict: 'achieved' },
      ]),
    ).toBe('achieved');
    expect(aggregateSkepticVerdicts([])).toBe('achieved');
  });
});

describe('mergeGaps (Phase 3)', () => {
  it('returns undefined when no skeptic failed', () => {
    expect(mergeGaps(['VERDICT: PASS', 'VERDICT: PASS'])).toBeUndefined();
  });

  it('merges FAIL reports into a gaps summary', () => {
    const gaps = mergeGaps(['all good\nVERDICT: PASS', '2 tests red\nVERDICT: FAIL']);
    expect(gaps).toBeTruthy();
    expect(gaps).toContain('tests');
  });
});

describe('fingerprintOf', () => {
  it('normalizes whitespace and caps length', () => {
    const a = fingerprintOf('  fix   the   tests  ');
    const b = fingerprintOf('fix the tests');
    expect(a).toBe(b);
  });
});

describe('GoalTracker stall counter (Phase 3)', () => {
  it('increments when the gap fingerprint repeats and resets on change', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });

    expect(t.setGaps('fix tests', 'fp-A')).toBe(0); // first time: baseline
    expect(t.setGaps('fix tests', 'fp-A')).toBe(1); // same fp → stall 1
    expect(t.setGaps('fix tests', 'fp-A')).toBe(2); // same fp → stall 2
    expect(t.setGaps('fix build', 'fp-B')).toBe(0); // changed fp → reset
    expect(t.classifierStallCount()).toBe(0);
    expect(t.classifierRunsAttempted()).toBe(4);
  });

  it('snapshot round-trips classifier counters', () => {
    const t = new GoalTracker();
    t.transition({ type: 'start', objective: 'X' });
    t.setGaps('g', 'fp');
    t.setGaps('g', 'fp');
    t.recordStrategistFired();

    const snap = t.snapshot();
    const restored = new GoalTracker();
    restored.restore(snap);
    expect(restored.classifierStallCount()).toBe(1);
    expect(restored.classifierRunsAttempted()).toBe(2);
    expect(restored.lastStrategistFiredAt()).toBeTruthy();
  });
});

describe('verifyGoalCompletion (mocked runAgent)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../tool/SubagentTool/runAgent.js', () => ({
      runAgentSync: vi.fn(async () => ({
        id: 'm1',
        role: 'assistant',
        content: 'Build ok\nVERDICT: PASS',
        timestamp: Date.now(),
      })),
    }));
  });

  it('returns blocked when no verification agent is available', async () => {
    const { verifyGoalCompletion: verify } = await import('../goal-evaluator.js');
    const r = await verify({
      objective: 'X',
      finalSummary: 'y',
      context: { options: {} } as never,
      agentDefinitions: [],
    });
    expect(r.verdict).toBe('blocked');
  });
});

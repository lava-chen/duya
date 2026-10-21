/**
 * The comparison rule, on its own.
 *
 * ## Why this file exists
 *
 * `eval-legacy-loop.test.ts` asserts that a normalised run contains no
 * timestamp and no random id. That assertion is NECESSARY and INSUFFICIENT:
 * a normaliser that collapsed nothing at all would also produce a run free of
 * stray ids, whenever the case happened not to contain one. A mutation that
 * disabled UUID collapsing therefore passed the loop test.
 *
 * So the rule is tested from the other direction here: feed the normaliser
 * values that are DEFINITELY not normalisable away, and require the output to
 * differ. That is the property the baseline comparison silently depends on —
 * and its converse, that behaviour is NOT collapsed, is asserted just as
 * explicitly, because a normaliser that flattened everything would make the
 * pre-R2 comparison agree on everything and mean nothing.
 */

import { describe, expect, it } from 'vitest';
import { diffNormalised, normaliseText, normaliseValue, type NormalisedRun } from './eval-normalise';

describe('E4.1 — what normalisation collapses, and what it must not', () => {
  it('collapses each kind of noise it claims to', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['run 90342ab9-2c16-44b5-a249-dab87a250f95 ended', 'run <uuid> ended'],
      ['at 2026-10-03T15:02:02.575Z it settled', 'at <time> it settled'],
      ['took 1791039809730 ms', 'took <epoch-ms> ms'],
      // Exactly 64 hex characters, which is what `manifestHash` actually is.
      // (The count matters: the rule is anchored to a full digest, so a 62- or
      // 66-character string is deliberately left alone.)
      ['hash 114ff897e4561f0a9b0c1d2e3f40516273849d5b0c1e2f3a4b5c6d7e8f9a0b1c', 'hash <digest>'],
      ['listening on 127.0.0.1:63233', 'listening on 127.0.0.1:<port>'],
    ];
    for (const [raw, expected] of cases) {
      expect(normaliseText(raw)).toBe(expected);
    }
  });

  it('does NOT collapse a hex string that is not a full digest', () => {
    // The boundary of the digest rule. A short hex id is identity, not noise:
    // collapsing it would hide a real behavioural difference behind a
    // placeholder, which is the failure mode this normaliser exists to avoid.
    // A 66-character string is equally untouched, because 64 is the rule.
    expect(normaliseText('id 114ff897e4')).toBe('id 114ff897e4');
    expect(normaliseText('hash 114ff897e4561f0a9b0c1d2e3f40516273849d5b0c1e2f3a4b5c6d7e8f9a0b1c2d'))
      .toBe('hash 114ff897e4561f0a9b0c1d2e3f40516273849d5b0c1e2f3a4b5c6d7e8f9a0b1c2d');
  });

  it('leaves behaviour untouched', () => {
    // The converse, and the reason the comparison is worth anything: a
    // normaliser that flattened these too would make every run agree with
    // every other run.
    for (const raw of [
      'EVAL_LOOP_OK',
      'manifest_hash_mismatch',
      'chat:done',
      'read',
      'succeeded',
    ]) {
      expect(normaliseText(raw)).toBe(raw);
    }
  });

  it('normalises nested values and keeps their keys', () => {
    const out = normaliseValue({
      runId: '90342ab9-2c16-44b5-a249-dab87a250f95',
      status: 'completed',
      tool: { name: 'read', outcome: 'succeeded' },
    }) as Record<string, Record<string, unknown>>;
    expect(out['runId']).toBe('<uuid>');
    expect(out['status']).toBe('completed');
    expect(out['tool']).toEqual({ name: 'read', outcome: 'succeeded' });
  });
});

describe('E4.1 — the diff reports which field moved', () => {
  const base: NormalisedRun = {
    terminalStatus: 'completed',
    terminalErrorCode: null,
    frameTypes: ['ready', 'chat:text', 'chat:done'],
    runEventKinds: [],
    providerRequestCount: 2,
    toolAttempts: [],
    usage: { inputTokens: 41, outputTokens: 7 },
    manifestDecisions: { version: 1 },
    workerDbActions: ['session:get'],
  };

  it('reports nothing for two identical runs', () => {
    expect(diffNormalised(base, { ...base })).toEqual([]);
  });

  it('names each differing field rather than returning a boolean', () => {
    // A boolean discards exactly the information a reviewer needs, which is
    // WHY the loop test logs the diff instead of asserting on it.
    const changed: NormalisedRun = {
      ...base,
      terminalStatus: 'failed',
      toolAttempts: [{ name: 'read', outcome: 'failed' }],
    };
    const differences = diffNormalised(base, changed);
    expect(differences).toHaveLength(2);
    expect(differences.join('\n')).toMatch(/terminalStatus/);
    expect(differences.join('\n')).toMatch(/toolAttempts/);
  });

  it('notices a usage difference, which is never noise', () => {
    // Usage is the one number the offline provider declares exactly, so a
    // difference is a mis-parse or a mis-accumulation. Collapsing it would
    // discard the most load-bearing thing the fixture exists to provide.
    const differences = diffNormalised(base, { ...base, usage: { inputTokens: 41, outputTokens: 999 } });
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatch(/usage/);
  });

  it('notices a late-frame verdict, which is a behavioural fact', () => {
    const differences = diffNormalised(base, { ...base, runEventKinds: ['late_frame'] });
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatch(/runEventKinds/);
  });
});

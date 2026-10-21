/**
 * Plan 587 E4.3 — the failing-layer vocabulary.
 *
 * The property under test is that attribution is DERIVED from the protocol's own
 * closed error-code set, and that the three hard cases behave differently from
 * each other:
 *
 *   - a code nobody classified is `unknown`, NOT a guess;
 *   - a code outside the closed set is `contract`, because an emitter using
 *     vocabulary the contract does not define IS a contract violation;
 *   - `internal` is the catch-all and deliberately unattributed.
 *
 * The `codeCoverage` test is the pressure that keeps this honest: a NEW error
 * code added to the protocol that nobody has classified fails it, so a code
 * cannot arrive without a layer.
 */

import { ERROR_CODES } from '@duya/agent-protocol';
import { describe, expect, it } from 'vitest';
import { attribute, codeCoverage, UNATTRIBUTED_CODES, type AttributionFacts } from './layer';

describe('E4.3 — attributing a failure to a layer', () => {
  it('maps a real protocol code to the layer that owns it', () => {
    expect(attribute({ terminalErrorCode: 'manifest_mismatch' }).layer).toBe('contract');
    expect(attribute({ terminalErrorCode: 'runtime_crash' }).layer).toBe('host-adapter');
    expect(attribute({ terminalErrorCode: 'tool_timeout' }).layer).toBe('tool');
    expect(attribute({ terminalErrorCode: 'persistence_failed' }).layer).toBe('storage');
    expect(attribute({ terminalErrorCode: 'permission_denied_by_policy' }).layer).toBe('policy');
    expect(attribute({ terminalErrorCode: 'budget_exhausted' }).layer).toBe('model-decision');
  });

  it('reports `unknown` for a real code nobody has classified, and does NOT guess from its name', () => {
    const result = attribute({ terminalErrorCode: 'internal' });
    expect(result.layer).toBe('unknown');
    // The rule string must SAY why, so a reader can tell "unclassified" from
    // "attributed to nothing because nothing was observed".
    expect(result.rule).toMatch(/unclassified/);
  });

  it('reports `contract` for a code outside the protocol closed set', () => {
    const result = attribute({ terminalErrorCode: 'not_a_real_code' });
    expect(result.layer).toBe('contract');
    expect(result.rule).toMatch(/outside the protocol's closed ErrorCode set/);
  });

  it('reports `unknown` for a failed terminal that named no code at all', () => {
    const result = attribute({ terminalStatus: 'failed', terminalErrorCode: null });
    expect(result.layer).toBe('unknown');
    expect(result.rule).toMatch(/named no error code/);
  });

  it('derives a layer from artefact evidence when there is no error code', () => {
    expect(attribute({ toolErrorObserved: true }).layer).toBe('tool');
    expect(attribute({ toolResultAbsent: true }).layer).toBe('host-adapter');
    expect(attribute({ storageGapObserved: true }).layer).toBe('storage');
    expect(attribute({ redactionBreach: true }).layer).toBe('policy');
  });

  it('lets an environment block outrank every other fact, because nothing was observed', () => {
    const result = attribute({
      environmentBlock: 'live-provider-credentials: no key',
      terminalErrorCode: 'tool_failed',
    });
    expect(result.layer).toBe('environment');
    expect(result.rule).toMatch(/could not run here/);
  });

  it('has classified, or explicitly declined to classify, every real protocol code', () => {
    const coverage = codeCoverage();
    // The pressure: a new code with no layer and no recorded reason fails here.
    expect(coverage.unmapped).toEqual([]);
    // And the two declined codes must keep their reasons, so the decline is
    // visible rather than looking like an oversight.
    for (const code of Object.keys(coverage.unclassified)) {
      expect(UNATTRIBUTED_CODES[code]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('never attributes a code to a layer outside the closed seven', () => {
    const facts: AttributionFacts[] = ERROR_CODES.map((code) => ({ terminalErrorCode: code }));
    const allowed = new Set([
      'contract', 'host-adapter', 'model-decision', 'tool', 'storage', 'policy', 'environment', 'unknown',
    ]);
    for (const code of ERROR_CODES) {
      expect(allowed.has(attribute({ terminalErrorCode: code }).layer)).toBe(true);
    }
    expect(facts.length).toBe(ERROR_CODES.length);
  });
});

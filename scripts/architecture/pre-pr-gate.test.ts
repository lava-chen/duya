/**
 * pre-pr-gate.test.ts — the local checklist must be the CI job, both ways.
 *
 * A one-way assertion ("every CI gate is in the checklist") still lets a local
 * gate exist that CI never runs, which is the exact failure the workflow
 * comments record for gates that shipped with no runner. So the parity check
 * is symmetric and the test feeds it a truncated CI list as a counterexample.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { FULL_SUITES, STEPS, ciParity, npmScripts } from './pre-pr-gate.mjs';

const ROOT = path.resolve(__dirname, '../..');

function architectureCiScripts(): string[] {
  const workflow = parse(readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8'));
  const runs = workflow.jobs.architecture.steps
    .map((step: { run?: string }) => step.run ?? '')
    .join('\n');
  return [...new Set([...runs.matchAll(/npm run ([a-zA-Z0-9:_-]+)/gu)].map((m) => m[1]))].sort();
}

describe('pre-PR gate / CI parity', () => {
  it('runs every npm gate in the CI architecture job', () => {
    const ci = architectureCiScripts();
    expect(ci.length).toBeGreaterThan(10);
    const parity = ciParity(ci);
    expect(parity.missingLocally).toEqual([]);
    expect(parity.missingInCi).toEqual([]);
  });

  it('catches a CI job that gained a gate the checklist never heard of', () => {
    const ci = [...architectureCiScripts(), 'architecture:new-gate'].sort();
    expect(ciParity(ci).missingLocally).toEqual(['architecture:new-gate']);
  });

  it('catches a local gate that CI would never run', () => {
    const ci = architectureCiScripts().filter((script) => script !== 'bundle:verify');
    expect(ciParity(ci).missingInCi).toContain('bundle:verify');
  });

  it('keeps the worker state and bundle freshness gates in the checklist', () => {
    // These are the two that three of the seven audited PRs missed. Naming
    // them here is deliberate: a future "cleanup" that drops them loses the
    // one local signal that would have caught those PRs before CI.
    const scripts = npmScripts(STEPS);
    expect(scripts).toContain('architecture:worker-module-state');
    expect(scripts).toContain('bundle:verify');
  });

  it('puts the headless build before the headless probe and its guard', () => {
    const names = STEPS.map((step) => step.name);
    expect(names.indexOf('Build Host dependency closure for A1')).toBeLessThan(
      names.indexOf('Headless load of the cli handler layer (A1)'),
    );
    expect(names.indexOf('Headless load of the cli handler layer (A1)')).toBeLessThan(
      names.indexOf('Guard: A1 must have scanned something'),
    );
  });

  it('keeps --full as the only home of the minute-scale suites', () => {
    expect(npmScripts(STEPS)).not.toContain('typecheck:all');
    expect(FULL_SUITES.map((step) => step.name)).toContain('typecheck:all');
  });
});

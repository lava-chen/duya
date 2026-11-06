/**
 * Plan 624 v2 G1 — architecture guard for the single policy point.
 *
 * Unit tests can prove `composeAgent` behaves; they cannot prove the session
 * stopped calling the resolvers on its own. This test reads the production
 * source and fails when a second decision path is reintroduced.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtime = readFileSync(
  new URL('../../src/worker-session-runtime.ts', import.meta.url),
  'utf8',
);
const driver = readFileSync(
  new URL('../../src/worker-engine-driver.ts', import.meta.url),
  'utf8',
);
const port = readFileSync(
  new URL('../../src/worker-run-session-port.ts', import.meta.url),
  'utf8',
);

const RESOLVERS = [
  'resolvePromptSelection',
  'resolveToolSelection',
  'resolveModeSelection',
  'resolvePermissionSelection',
  'resolveCacheSelection',
  'resolveTimeReminder',
];

describe('plan 624 v2 — single composition entry point', () => {
  it('does not call any dimension resolver from the session runtime', () => {
    for (const name of RESOLVERS) {
      expect(runtime).not.toContain(`${name}(`);
    }
  });

  it('creates exactly one plan per run and threads it through the handle', () => {
    expect(runtime).toContain('const composition = this._composeTurn({ options, appliedProfile, turnContext })');
    expect(runtime).toContain('request.composition');
    expect(runtime).toContain('orchestrator: this._readOrchestratorMode(composition)');
    expect(port).toContain('readonly composition?:');
    expect(driver).toContain('composition: run.composition');
  });

  it('reads turn injections only through the frozen plan', () => {
    const start = runtime.indexOf('private async _buildSystemPrompt(');
    const end = runtime.indexOf('this._reportHostBlockDigests(hostBlocks);', start);
    const body = runtime.slice(start, end);

    expect(body).toContain('const overrides = composition.overrides;');
    expect(body).not.toMatch(/\boptions\?\./);
    expect(body).not.toMatch(/\boptions\./);
    expect(body).not.toContain('resolvePromptSelection(');
  });

  it('keeps the startup facts on the same composition entry', () => {
    expect(runtime).toContain('composeStartup({');
    expect(runtime).toContain('startup.permissions.permissionMode');
    expect(runtime).toContain('startup.cache');
  });
});

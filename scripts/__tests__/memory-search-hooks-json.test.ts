/**
 * scripts/__tests__/memory-search-hooks-json.test.ts
 *
 * Validates the memory-search skill's hooks.json template against the
 * real hook.json loader, so the file the skill tells the agent to install
 * can never drift from the schema.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseHooksJsonContent } from '../../packages/agent/src/hooks/hooks-json';

const TEMPLATE = path.resolve(
  process.cwd(),
  'packages',
  'agent',
  'skills',
  '.system',
  'memory-search',
  'hooks.json',
);

describe('memory-search hooks.json template', () => {
  it('is valid JSON', () => {
    expect(() => JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'))).not.toThrow();
  });

  it('parses into a valid UserPromptSubmit process hook through the real loader', () => {
    const raw = fs.readFileSync(TEMPLATE, 'utf8');
    const settings = parseHooksJsonContent(raw, 'memory-search/hooks.json');
    expect(settings).toBeDefined();

    const ups = settings?.UserPromptSubmit;
    expect(ups).toHaveLength(1);
    expect(ups![0].matcher).toBeUndefined(); // fire on every prompt

    const hook = ups![0].hooks[0];
    expect(hook.type).toBe('process');
    if (hook.type === 'process') {
      expect(hook.command).toBe('node');
      expect(hook.args?.[0]).toContain('memory-search.mjs');
      // Plan 430 — synchronous execution so DuyaAgent can inject the
      // retrieved memory into the FIRST turn (the previous async + asyncRewake
      // path only logged the contexts and never injected them into the model
      // — see packages/agent/src/agent/DuyaAgent.ts:548 before plan 430).
      expect(hook.async).toBeUndefined();
      expect(hook.asyncRewake).toBeUndefined();
      // A bounded timeout so a slow embedding endpoint never blocks the
      // first turn for the executor's default 60s.
      expect(typeof hook.timeoutMs).toBe('number');
      expect(hook.timeoutMs).toBeGreaterThan(0);
      expect(hook.timeoutMs).toBeLessThan(60_000);
    }
  });

  it('keeps the placeholder script path obvious (agents must rewrite args[0])', () => {
    const raw = fs.readFileSync(TEMPLATE, 'utf8');
    // The template ships with a placeholder path that the installing agent
    // is required to replace with the real absolute path. Plan 430 rewrote
    // the description to call out the synchronous + full-body contract, so
    // the marker phrase moved to "EDIT args[0]" — same intent, new wording.
    expect(raw).toContain('memory-search.mjs');
    expect(raw).toContain('EDIT args[0]');
  });
});

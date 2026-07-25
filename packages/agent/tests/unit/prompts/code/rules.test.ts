/**
 * Tests for the code agent's `# Rules for getting work done` chapter.
 *
 * Asserts the chapter contains the Codex-shaped five-sub-heading
 * structure and the autonomy/persistence taxonomy.
 */

import { describe, it, expect } from 'vitest';
import { getRulesSection } from '../../../../src/prompts/code/sections/rules.js';
import type { PromptContext } from '../../../../src/prompts/types.js';

function makeCtx(enabledTools: string[] = []): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  } as PromptContext;
}

describe('getRulesSection (code)', () => {
  it('uses the parent heading # Rules for getting work done', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/^# Rules for getting work done\b/m);
  });

  it('contains all five sub-headings', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/^## Doing tasks\b/m);
    expect(out).toMatch(/^## Using your tools\b/m);
    expect(out).toMatch(/^## File editing constraints\b/m);
    expect(out).toMatch(/^## Executing actions with care\b/m);
    expect(out).toMatch(/^## Autonomy and persistence\b/m);
  });

  it('opens with the dedicated-tools-over-shell rule (rg/grep)', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/prefer parallelized searches and the dedicated tools/);
    expect(out).toMatch(/Grep/);
    expect(out).toMatch(/Glob/);
  });

  it('preserves the destructive-actions taxonomy', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/Destructive operations/);
    expect(out).toMatch(/Hard-to-reverse operations/);
    expect(out).toMatch(/Actions visible to others/);
    expect(out).toMatch(/Uploading content to third-party web tools/);
  });

  it('preserves the autonomy/persistence taxonomy (Answer / Diagnose / Change / Monitor)', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/Answer, explain, review, or report status/);
    expect(out).toMatch(/Diagnose:/);
    expect(out).toMatch(/Change or build:/);
    expect(out).toMatch(/Monitor or wait:/);
  });

  it('forbids destructive shell shortcuts as a response to obstacles', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/do not use destructive actions as a shortcut/);
  });

  it('keeps the AskUserQuestion escalation rule under Doing tasks', () => {
    const out = getRulesSection(makeCtx());
    expect(out).toMatch(/AskUserQuestion/);
    expect(out).toMatch(/only when you're genuinely stuck after investigation/);
  });
});
/**
 * Session guidance .hbs byte-level parity test — Plan 550 1d-rest.
 *
 * Companion to dynamic-sections.test.ts; runs independently because
 * sessionGuidance.ts has 5 conditional paragraphs and a 5-paragraph
 * `{{#if}}` chain in the .hbs template, so a divergence here is more
 * likely than the simpler 1d-rest migrations.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js';
import { getSessionGuidanceSection } from '../../../../src/prompts/sections/dynamic/sessionGuidance.js';

const ASSETS_ROOT = resolve(__dirname, '../../../../src/prompts/assets');

function ctxWith(overrides: any = {}) {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set<string>([
      'Read', 'Edit', 'Write',
      'AskUserQuestion', 'Subagent', 'Skill', 'DiscoverSkills',
      'Glob', 'Grep', 'Bash',
    ]),
    sessionStartTime: 0,
    isSkillSearchEnabled: true,
    isForkSubagentEnabled: false,
    isVerificationAgentEnabled: true,
    isNonInteractiveSession: false,
    hasEmbeddedSearchTools: false,
    ...overrides,
  };
}

describe('session-guidance hbs byte-level parity (Plan 550 1d-rest)', () => {
  const system = new HbsPromptSystem({ assetsRoot: ASSETS_ROOT });

  async function check(ctx: any) {
    const ts = await getSessionGuidanceSection(ctx as any);
    const hbs = system.renderStaticTemplate('dynamic/session-guidance.hbs', ctx as any).trim();
    const hbsNorm = hbs === '' ? null : hbs;
    expect(hbsNorm).toBe(ts);
  }

  it('matches when most paragraphs apply', async () => {
    await check(ctxWith());
  });

  it('matches when no relevant tools are available (section omitted)', async () => {
    await check(ctxWith({ enabledTools: new Set<string>(['Read', 'Edit', 'Write']) }));
  });

  it('matches when fork subagent is enabled (different fork paragraph)', async () => {
    await check(ctxWith({ isForkSubagentEnabled: true }));
  });

  it('matches when embedded search tools are enabled (different search label)', async () => {
    await check(ctxWith({ hasEmbeddedSearchTools: true }));
  });

  it('matches when session is non-interactive (omits shell-suggestion paragraph)', async () => {
    await check(ctxWith({ isNonInteractiveSession: true }));
  });

  it('matches when DiscoverSkills is unavailable (omits discover paragraph)', async () => {
    await check(ctxWith({
      enabledTools: new Set<string>(['Read', 'Edit', 'Write', 'AskUserQuestion', 'Subagent', 'Skill']),
    }));
  });

  it('matches when verification agent is disabled (omits verification paragraph)', async () => {
    await check(ctxWith({ isVerificationAgentEnabled: false }));
  });
});
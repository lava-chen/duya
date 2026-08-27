import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { getSkillRegistry, resetSkillRegistry } from '../../skills/registry.js';
import type { PromptSkill } from '../../skills/types.js';
import { collectSkillInjections } from '../index.js';

/** Platform-independent expected SKILL.md location (matches the `join` used by the module). */
function escapeLoc(root: string, file: string): string {
  return join(root, file);
}

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'commit',
    description: 'Smart git commit messages',
    source: 'project',
    skillRoot: '/tmp/skills/commit',
    getPromptForCommand: async () => 'Commit message instructions body',
    ...overrides,
  };
}

describe('collectSkillInjections (Plan 450 Phase H)', () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  afterEach(() => {
    resetSkillRegistry();
  });

  it('returns empty for no names', async () => {
    expect(await collectSkillInjections([])).toEqual([]);
  });

  it('builds a <skill> fragment with name, location, and the loaded body', async () => {
    getSkillRegistry().register(makeSkill());
    const injections = await collectSkillInjections(['commit']);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.envelope).toBe('skill');
    expect(injections[0]!.body).toContain('<name>commit</name>');
    expect(injections[0]!.body).toContain(`<location>${escapeLoc('/tmp/skills/commit', 'SKILL.md')}</location>`);
    expect(injections[0]!.body).toContain('Commit message instructions body');
  });

  it('resolves aliases to the registered skill', async () => {
    getSkillRegistry().register(makeSkill({ aliases: ['code-review'], name: 'review' }));
    const injections = await collectSkillInjections(['code-review']);
    expect(injections).toHaveLength(1);
    expect(injections[0]!.body).toContain('<name>review</name>');
  });

  it('skips unknown skill names', async () => {
    getSkillRegistry().register(makeSkill());
    expect(await collectSkillInjections(['nonexistent'])).toEqual([]);
  });

  it('skips hidden, model-invocation-disabled, conditional, and disabled skills', async () => {
    getSkillRegistry().register(makeSkill({ name: 'hidden', isHidden: true }));
    getSkillRegistry().register(makeSkill({ name: 'nomodel', disableModelInvocation: true }));
    getSkillRegistry().register(makeSkill({ name: 'cond', isConditional: true }));
    getSkillRegistry().register(makeSkill({ name: 'off', isEnabled: () => false }));
    const injections = await collectSkillInjections(['hidden', 'nomodel', 'cond', 'off']);
    expect(injections).toEqual([]);
  });

  it('skips skills whose prompt body fails to load or is empty', async () => {
    getSkillRegistry().register(makeSkill({ name: 'broken', getPromptForCommand: async () => { throw new Error('boom'); } }));
    getSkillRegistry().register(makeSkill({ name: 'empty', getPromptForCommand: async () => '' }));
    expect(await collectSkillInjections(['broken', 'empty'])).toEqual([]);
  });

  it('deduplicates the same resolved skill mentioned twice', async () => {
    getSkillRegistry().register(makeSkill({ aliases: ['c'] }));
    const injections = await collectSkillInjections(['commit', 'c']);
    expect(injections).toHaveLength(1);
  });

  it('escapes XML-significant characters in name and location', async () => {
    getSkillRegistry().register(makeSkill({ name: 'weird<name>' }));
    const injections = await collectSkillInjections(['weird<name>']);
    expect(injections[0]!.body).toContain('<name>weird&lt;name&gt;</name>');
  });
});

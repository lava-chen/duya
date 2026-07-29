import { afterEach, describe, expect, it } from 'vitest';
import { getSkillRegistry, resetSkillRegistry } from '../../src/skills/registry.js';
import type { PromptSkill } from '../../src/skills/types.js';
import { SkillTool } from '../../src/tool/SkillTool/SkillTool.js';
import { getPrompt } from '../../src/tool/SkillTool/prompt.js';

function makeSkill(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    type: 'prompt',
    name: 'pdf',
    description: 'Create and inspect PDF documents.',
    source: 'bundled',
    getPromptForCommand: async () => 'PDF workflow instructions',
    ...overrides,
  };
}

afterEach(() => {
  resetSkillRegistry();
});

describe('SkillTool catalog contract', () => {
  it('advertises only skills that the model can load', () => {
    const registry = getSkillRegistry();
    registry.register(makeSkill());
    registry.register(makeSkill({ name: 'hidden', isHidden: true }));
    registry.register(makeSkill({ name: 'manual-only', disableModelInvocation: true }));
    registry.register(makeSkill({ name: 'disabled', isEnabled: () => false }));

    expect(registry.listModelInvocable().map((skill) => skill.name)).toEqual(['pdf']);
    expect(SkillTool.listAvailableSkills().map((skill) => skill.name)).toEqual(['pdf']);
  });

  it('returns a compact unknown-skill error without leaking every skill prompt', async () => {
    const registry = getSkillRegistry();
    registry.register(makeSkill());
    registry.register(makeSkill({ name: 'hidden', isHidden: true }));
    registry.register(makeSkill({ name: 'manual-only', disableModelInvocation: true }));

    const result = await new SkillTool().execute({ skill: 'missing' });
    const payload = JSON.parse(result.result) as { availableSkills: string[] };

    expect(result.error).toBe(true);
    expect(payload.availableSkills).toEqual(['pdf']);
  });

  it('loads the selected skill instructions without duplicating the catalog guide', async () => {
    getSkillRegistry().register(makeSkill());

    const result = await new SkillTool().execute({ skill: 'pdf' });
    const payload = JSON.parse(result.result) as { success: boolean; content: string };

    expect(payload).toEqual({
      success: true,
      commandName: 'pdf',
      status: 'inline',
      allowedTools: undefined,
      model: undefined,
      content: 'PDF workflow instructions',
    });
    expect(getPrompt()).not.toContain('Available skills:');
    expect(getPrompt()).not.toContain('BLOCKING REQUIREMENT');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { SkillTool, getSkillToolPrompt, type SkillToolPort, type SkillToolPromptSource } from '../src/skill-tool.js';

function makeSkill(overrides: Partial<SkillToolPromptSource> = {}): SkillToolPromptSource {
  return {
    name: 'pdf',
    getPromptForCommand: async () => 'PDF workflow instructions',
    ...overrides,
  };
}

function makePort(skills: SkillToolPromptSource[]): SkillToolPort {
  return {
    getSkill: (name) => skills.find((skill) => skill.name === name),
    listModelInvocable: () => skills
      .filter((skill) => !skill.disableModelInvocation && !skill.isConditional)
      .map(({ name }) => ({ name })),
  };
}

describe('Skill capability', () => {
  it('normalizes a leading slash and loads an inline skill prompt using the legacy narrow context shape', async () => {
    let receivedContext: unknown;
    const skill = makeSkill({
      allowedTools: ['Read'],
      model: 'summary-model',
      getPromptForCommand: vi.fn(async (_args, context) => {
        receivedContext = context;
        return 'PDF workflow instructions';
      }),
    });
    const result = await new SkillTool(makePort([skill])).execute({ skill: '/pdf', args: 'merge files' });
    const payload = JSON.parse(result.result) as Record<string, unknown>;
    expect(payload).toEqual({
      success: true,
      commandName: 'pdf',
      status: 'inline',
      allowedTools: ['Read'],
      model: 'summary-model',
      content: 'PDF workflow instructions',
    });
    expect(skill.getPromptForCommand).toHaveBeenCalledWith('merge files', expect.objectContaining({
      toolUseId: expect.any(String),
      options: { tools: [], commands: [], mainLoopModel: '', mcpClients: [] },
    }));
    expect(receivedContext).toMatchObject({ getAppState: expect.any(Function), setAppState: expect.any(Function) });
  });

  it('returns only model-invocable names for unknown and pending conditional skills', async () => {
    const tool = new SkillTool(makePort([
      makeSkill(),
      makeSkill({ name: 'hidden', disableModelInvocation: true }),
      makeSkill({ name: 'waiting', isConditional: true }),
    ]));
    const unknown = await tool.execute({ skill: 'missing' });
    expect(unknown.error).toBe(true);
    expect(JSON.parse(unknown.result)).toMatchObject({ error: 'Unknown skill: missing', availableSkills: ['pdf'] });

    const waiting = await tool.execute({ skill: 'waiting' });
    expect(waiting.error).toBe(true);
    expect(JSON.parse(waiting.result)).toMatchObject({
      error: expect.stringContaining('conditionally available'),
      availableSkills: ['pdf'],
    });
  });

  it('keeps disabled-skill errors and fork result envelopes', async () => {
    const disabled = await new SkillTool(makePort([
      makeSkill({ name: 'manual', disableModelInvocation: true }),
    ])).execute({ skill: 'manual' });
    expect(disabled.error).toBe(true);
    expect(JSON.parse(disabled.result).error).toContain('cannot be invoked automatically');

    const forkSkill = makeSkill({ context: 'fork', model: 'fork-model' });
    const forked = await new SkillTool(makePort([forkSkill])).execute({ skill: 'pdf' });
    expect(JSON.parse(forked.result)).toMatchObject({
      success: true,
      commandName: 'pdf',
      status: 'forked',
      agentId: expect.any(String),
      result: 'PDF workflow instructions',
    });
    expect(getSkillToolPrompt()).not.toContain('Available skills:');
    expect(getSkillToolPrompt()).toContain('<command-name>');
  });
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESET_AGENT_PROFILES } from '../../src/worker-profiles/types.js';
import { PromptsRegistry, resolvePromptSystemName } from '../../src/worker-prompts/registry.js';
import { resolvePromptAssetsRoot } from '../../src/worker-prompts/hbs/HbsPromptSystem.js';
import { PROJECT_COORDINATOR_ALLOWED_TOOLS, PROJECT_COORDINATOR_PROFILE_ID } from '../../src/project/identity.js';
import type { PromptContext } from '../../src/worker-prompts/types.js';

function projectPromptContext(): PromptContext {
  return {
    workingDirectory: 'E:\\repo',
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    modelName: 'test-model',
    enabledTools: new Set<string>(PROJECT_COORDINATOR_ALLOWED_TOOLS),
    sessionStartTime: 0,
  };
}

describe('project prompt system', () => {
  const coordinator = PRESET_AGENT_PROFILES.find(
    (profile) => profile.id === PROJECT_COORDINATOR_PROFILE_ID,
  );

  it('is the Coordinator profile’s own prompt system', () => {
    expect(coordinator?.promptSystem).toBe('project');
    expect(coordinator?.suppressIdentityBlock).toBe(true);
    expect(coordinator?.identityPrompt).toBeUndefined();
    expect(resolvePromptSystemName(coordinator?.promptSystem)).toBe('project');
    expect(PromptsRegistry.has('project')).toBe(true);
  });

  it('opens with its own identity and omits file-tool guidance', () => {
    const config = PromptsRegistry.getConfig('project');
    expect(config?.name).toBe('project');
    const names = config!.sections.map((section) => section.name ?? section.module);
    expect(names[0]).toBe('projectIdentity');
    expect(names).toEqual(expect.arrayContaining(['projectIdentity', 'projectOperation', 'projectDelegation', 'projectReporting', 'projectContextPolicy']));
    expect(names).not.toContain('tasks');
    expect(names).not.toContain('tools');
    expect(names).not.toContain('skills');
    expect(names).not.toContain('mcp');
    expect(names).not.toContain('vision');
    const assets = resolvePromptAssetsRoot();
    for (const template of [
      'project/identity.hbs',
      'project/operation.hbs',
      'project/delegation.hbs',
      'project/reporting.hbs',
      'project/context-policy.hbs',
    ]) {
      expect(config!.sections.some((section) => section.template === template)).toBe(true);
      expect(existsSync(join(assets, template))).toBe(true);
    }
  });

  it('renders identity first, then the operating contract', async () => {
    const system = PromptsRegistry.getOrCreate('project');
    expect(system).toBeDefined();
    const partition = await system!.buildSystemPromptPartition(projectPromptContext());
    const names = partition.stable.map((section) => section.name);
    expect(names[0]).toBe('projectIdentity');

    const byName = new Map(partition.stable.map((section) => [section.name, section.content]));
    const identity = byName.get('projectIdentity') ?? '';
    expect(identity).toContain('Project Coordinator');
    expect(identity).toContain('project records and work Sessions');
    expect(coordinator?.allowedTools).toEqual(['session', 'project']);

    const operation = byName.get('projectOperation') ?? '';
    expect(operation).toContain('project');
    expect(operation).toContain('revision just read');

    const delegation = byName.get('projectDelegation') ?? '';
    expect(delegation.trim()).not.toBe('');

    const reporting = byName.get('projectReporting') ?? '';
    expect(reporting).toContain('accept');
    expect(byName.get('projectContextPolicy')).toContain('A changed context section replaces');
    expect(names).not.toContain('system');
  });
});

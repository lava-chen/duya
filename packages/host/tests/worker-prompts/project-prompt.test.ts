import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRESET_AGENT_PROFILES } from '../../src/worker-profiles/types.js';
import { PromptsRegistry, resolvePromptSystemName } from '../../src/worker-prompts/registry.js';
import { resolvePromptAssetsRoot } from '../../src/worker-prompts/hbs/HbsPromptSystem.js';
import { PROJECT_COORDINATOR_PROFILE_ID } from '../../src/project/identity.js';

describe('project prompt system', () => {
  const coordinator = PRESET_AGENT_PROFILES.find(
    (profile) => profile.id === PROJECT_COORDINATOR_PROFILE_ID,
  );

  it('is the Coordinator profile’s own prompt system', () => {
    expect(coordinator?.promptSystem).toBe('project');
    expect(resolvePromptSystemName(coordinator?.promptSystem)).toBe('project');
    expect(PromptsRegistry.has('project')).toBe(true);
  });

  it('ships delegation and reporting instead of file-tool guidance', () => {
    const config = PromptsRegistry.getConfig('project');
    expect(config?.name).toBe('project');
    const names = config!.sections.map((section) => section.name ?? section.module);
    expect(names).toEqual(expect.arrayContaining(['projectDelegation', 'projectReporting']));
    expect(names).not.toContain('skills');
    expect(names).not.toContain('mcp');
    expect(names).not.toContain('vision');
    const assets = resolvePromptAssetsRoot();
    for (const template of ['project/delegation.hbs', 'project/reporting.hbs']) {
      expect(config!.sections.some((section) => section.template === template)).toBe(true);
      expect(existsSync(join(assets, template))).toBe(true);
    }
  });
});

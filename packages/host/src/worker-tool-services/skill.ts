import type { SkillMetadata } from '../skills/types.js';
import type { SkillToolPort } from '@duya/capabilities/skill-tool';
import { getSkillRegistry } from '../skills/registry.js';

/** Creates the narrow catalog/prompt port used by the pure Skill capability. */
export function createWorkerSkillToolPort(): SkillToolPort {
  const registry = getSkillRegistry();
  return {
    getSkill: (name) => registry.get(name),
    listModelInvocable: () => registry.listModelInvocable().map(({ name }) => ({ name })),
  };
}

export function listWorkerAvailableSkills(): SkillMetadata[] {
  const registry = getSkillRegistry();
  return registry.listModelInvocable().map((skill) => registry.getMetadata(skill.name)!);
}

export function getWorkerSkillMetadata(name: string): SkillMetadata | undefined {
  return getSkillRegistry().getMetadata(name);
}

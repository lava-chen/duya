/**
 * Bundled Skill System for duya Agent
 * Programmatically registered skills that ship with the agent
 * Adapted from claude-code-haha/src/skills/bundledSkills.ts
 */

import type { ToolUseContext } from '../types.js';
import type { BundledSkillDefinition, PromptSkill } from './types.js';
import { getSkillRegistry } from './registry.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Internal registry for bundled skills
 */
const bundledSkills: PromptSkill[] = [];

/**
 * Get the bundled skills root directory
 */
export function getBundledSkillExtractDir(skillName: string): string {
  // In duya, bundled skills are extracted to a temp directory
  return path.join(os.tmpdir(), 'duya-skills', skillName);
}

/**
 * Register a bundled skill
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const skill: PromptSkill = {
    type: 'prompt',
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    allowedTools: definition.allowedTools,
    model: definition.model,
    source: 'bundled',
    disableModelInvocation: definition.disableModelInvocation ?? false,
    userInvocable: definition.userInvocable ?? true,
    isEnabled: definition.isEnabled,
    isHidden: !(definition.userInvocable ?? true),
    skillRoot: undefined,
    context: definition.context,
    agent: definition.agent,
    hooks: definition.hooks,
    whenToUse: definition.whenToUse,
    argumentHint: definition.argumentHint,
    category: definition.category,
    async getPromptForCommand(args, context): Promise<string> {
      // Extract files if needed
      if (definition.files && Object.keys(definition.files).length > 0) {
        await extractBundledSkillFiles(definition.name, definition.files);
      }

      // Get the prompt content
      let content = await definition.getPromptForCommand(args, context);

      // Add base directory prefix if files were extracted
      if (definition.files) {
        const baseDir = getBundledSkillExtractDir(definition.name);
        content = `Base directory for this skill: ${baseDir}\n\n${content}`;
      }

      return content;
    },
  };

  bundledSkills.push(skill);
  getSkillRegistry().register(skill);
}

/**
 * Extract bundled skill files to disk
 */
async function extractBundledSkillFiles(
  skillName: string,
  files: Record<string, string>,
): Promise<string | null> {
  const dir = getBundledSkillExtractDir(skillName);

  try {
    await fs.mkdir(dir, { recursive: true });

    for (const [relPath, content] of Object.entries(files)) {
      const filePath = path.join(dir, relPath);
      const fileDir = path.dirname(filePath);

      await fs.mkdir(fileDir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    }

    return dir;
  } catch (e) {
    console.error(`Failed to extract bundled skill '${skillName}':`, e);
    return null;
  }
}

/**
 * Get all registered bundled skills
 */
export function getBundledSkills(): PromptSkill[] {
  return [...bundledSkills];
}

/**
 * Clear bundled skills registry (for testing)
 */
export function clearBundledSkills(): void {
  const registry = getSkillRegistry();
  for (const skill of bundledSkills) {
    registry.unregister(skill.name);
  }
  bundledSkills.length = 0;
}

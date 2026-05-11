/**
 * Conditional Skills Manager
 *
 * Manages skills with `paths` frontmatter that should only be activated
 * when matching files are being operated on.
 *
 * Inspired by claude-code-haha's conditional skills implementation.
 */

import type { PromptSkill } from './types.js';
import { getSkillRegistry } from './registry.js';

// State for conditional skills
const conditionalSkills = new Map<string, PromptSkill>();
const activatedConditionalSkillNames = new Set<string>();

/**
 * Check if a skill should be treated as conditional
 * (has paths frontmatter and hasn't been activated yet)
 */
export function isConditionalSkill(skill: PromptSkill): boolean {
  return Boolean(
    skill.paths &&
    skill.paths.length > 0 &&
    !activatedConditionalSkillNames.has(skill.name)
  );
}

/**
 * Register a skill as conditional (called during skill loading)
 */
export function registerConditionalSkill(skill: PromptSkill): void {
  if (skill.paths && skill.paths.length > 0) {
    conditionalSkills.set(skill.name, skill);
    skill.isConditional = true;
  }
}

/**
 * Check if a file path matches a glob pattern
 * Simple glob matching: * matches any characters except /
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // Normalize pattern: remove leading ./
  const normalizedPattern = pattern.replace(/^\.\//, '');

  // Handle ** at the start (matches any directory depth)
  if (normalizedPattern.startsWith('**/')) {
    const restPattern = normalizedPattern.slice(3); // Remove '**/'
    const regexPattern = restPattern
      .replace(/\*\*/g, '###GLOBSTAR###')
      .replace(/###GLOBSTAR###/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    const regex = new RegExp(regexPattern, 'i');
    return regex.test(filePath);
  }

  // Convert glob to regex for non-globstar patterns
  const regexPattern = normalizedPattern
    .replace(/\*\*/g, '###GLOBSTAR###')
    .replace(/###GLOBSTAR###/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(filePath);
}

/**
 * Check if a file path matches any of the skill's path patterns
 */
function matchesSkillPaths(filePath: string, skill: PromptSkill): boolean {
  if (!skill.paths || skill.paths.length === 0) return false;

  return skill.paths.some(pattern => matchGlob(filePath, pattern));
}

/**
 * Activate conditional skills that match the given file paths
 *
 * @param filePaths Array of file paths being operated on
 * @returns Array of newly activated skill names
 */
export function activateConditionalSkills(filePaths: string[]): string[] {
  if (conditionalSkills.size === 0) return [];

  const activated: string[] = [];

  for (const [name, skill] of conditionalSkills) {
    // Check if any file path matches this skill's patterns
    const shouldActivate = filePaths.some(filePath =>
      matchesSkillPaths(filePath, skill)
    );

    if (shouldActivate) {
      // Move from conditional to active
      skill.isConditional = false;
      activatedConditionalSkillNames.add(name);
      conditionalSkills.delete(name);
      activated.push(name);

      console.log(`[Skills] Activated conditional skill '${name}' (matched paths: ${skill.paths?.join(', ')})`);
    }
  }

  return activated;
}

/**
 * Get all pending conditional skills (not yet activated)
 */
export function getPendingConditionalSkills(): PromptSkill[] {
  return Array.from(conditionalSkills.values());
}

/**
 * Get the count of pending conditional skills
 */
export function getPendingConditionalSkillCount(): number {
  return conditionalSkills.size;
}

/**
 * Check if a skill has been activated
 */
export function isSkillActivated(name: string): boolean {
  return activatedConditionalSkillNames.has(name);
}

/**
 * Clear all conditional skill state (for testing/reset)
 */
export function clearConditionalSkills(): void {
  conditionalSkills.clear();
  activatedConditionalSkillNames.clear();
}

/**
 * Get all activated conditional skill names
 */
export function getActivatedSkillNames(): string[] {
  return Array.from(activatedConditionalSkillNames);
}

/**
 * Separate skills into unconditional and conditional lists
 *
 * @param skills All loaded skills
 * @returns [unconditionalSkills, conditionalSkills]
 */
export function separateConditionalSkills(skills: PromptSkill[]): [PromptSkill[], PromptSkill[]] {
  const unconditional: PromptSkill[] = [];
  const conditional: PromptSkill[] = [];

  for (const skill of skills) {
    if (isConditionalSkill(skill)) {
      conditional.push(skill);
    } else {
      unconditional.push(skill);
    }
  }

  return [unconditional, conditional];
}

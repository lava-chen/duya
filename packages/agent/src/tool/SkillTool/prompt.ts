/**
 * SkillTool Prompt
 * Fully adapted from claude-code-haha/src/tools/SkillTool/prompt.ts
 */

import type { SkillMetadata } from '../../skills/types.js';
import { getSkillRegistry } from '../../skills/registry.js';
import { stringWidth, truncate } from '../../skills/promptUtils.js';

// Skill listing gets 1% of the context window (in characters)
const SKILL_BUDGET_CONTEXT_PERCENT = 0.01;
const CHARS_PER_TOKEN = 4;
const DEFAULT_CHAR_BUDGET = 8000; // Fallback: 1% of 200k × 4

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate.
const MAX_LISTING_DESC_CHARS = 250;

// Minimum description length before going names-only
const MIN_DESC_LENGTH = 20;

// XML tag for skill name detection
const COMMAND_NAME_TAG = 'command-name';

/**
 * Get the character budget for skill listing based on context window
 */
function getCharBudget(contextWindowTokens?: number): number {
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * SKILL_BUDGET_CONTEXT_PERCENT * CHARS_PER_TOKEN,
    );
  }
  return DEFAULT_CHAR_BUDGET;
}

/**
 * Get the command description, optionally appending whenToUse
 */
function getCommandDescription(cmd: SkillMetadata): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description;
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '…'
    : desc;
}

/**
 * Format a command for listing
 */
function formatCommandDescription(cmd: SkillMetadata): string {
  return `- ${cmd.name}: ${getCommandDescription(cmd)}`;
}

/**
 * Format commands within the available character budget.
 * Bundled skills always get full descriptions.
 * Non-bundled skills may have their descriptions truncated to fit.
 */
function formatCommandsWithinBudget(
  commands: SkillMetadata[],
  contextWindowTokens?: number,
): string {
  if (commands.length === 0) return '';

  const budget = getCharBudget(contextWindowTokens);

  // Try full descriptions first
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }));

  // join('\n') produces N-1 newlines for N entries
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1);

  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n');
  }

  // Partition into bundled (never truncated) and rest
  const bundledIndices = new Set<number>();
  const restCommands: SkillMetadata[] = [];

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    if (cmd.source === 'bundled') {
      bundledIndices.add(i);
    } else {
      restCommands.push(cmd);
    }
  }

  // Compute space used by bundled skills (full descriptions, always preserved)
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  );
  const remainingBudget = budget - bundledChars;

  // Calculate space available for non-bundled skills
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n');
  }

  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1);
  const availableForDescs = remainingBudget - restNameOverhead;
  const maxDescLen = Math.floor(availableForDescs / restCommands.length);

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: non-bundled go names-only, bundled keep descriptions
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n');
  }

  // Truncate non-bundled descriptions to fit within budget
  return commands
    .map((cmd, i) => {
      // Bundled skills always get full descriptions
      if (bundledIndices.has(i)) return fullEntries[i]!.full;
      const description = getCommandDescription(cmd);
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`;
    })
    .join('\n');
}

/**
 * Get the skill listing formatted within budget
 */
function getSkillListing(contextWindowTokens?: number): string {
  const registry = getSkillRegistry();
  const skills = registry.listMetadata();

  if (skills.length === 0) {
    return 'No skills available.';
  }

  return formatCommandsWithinBudget(skills, contextWindowTokens);
}

/**
 * Get the complete skill tool prompt
 */
export function getPrompt(contextWindowTokens?: number): string {
  const skillListing = getSkillListing(contextWindowTokens);

  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments

Available skills:
${skillListing}

Important:
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again`;
}

export { COMMAND_NAME_TAG };

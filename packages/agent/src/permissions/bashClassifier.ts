/**
 * Bash Classifier for duya Agent
 * Adapted from claude-code-haha/src/utils/permissions/bashClassifier.ts
 *
 * Provides prompt-based classification for bash commands.
 * Rules with "prompt:" prefix in the content are extracted as natural-language
 * descriptions that the YOLO classifier can use to make decisions.
 */

import type { ToolPermissionContext } from './types.js';
import { getAllowRules, getDenyRules, getAskRules } from './permissions.js';

export const PROMPT_PREFIX = 'prompt:';

export type ClassifierResult = {
  matches: boolean;
  matchedDescription?: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

export type ClassifierBehavior = 'deny' | 'ask' | 'allow';

export function extractPromptDescription(
  ruleContent: string | undefined,
): string | null {
  if (!ruleContent) return null;
  if (ruleContent.startsWith(PROMPT_PREFIX)) {
    return ruleContent.slice(PROMPT_PREFIX.length).trim();
  }
  return null;
}

export function createPromptRuleContent(description: string): string {
  return `${PROMPT_PREFIX} ${description.trim()}`;
}

export function isClassifierPermissionsEnabled(): boolean {
  return true;
}

function extractBashPromptDescriptions(
  context: ToolPermissionContext,
  behavior: 'deny' | 'ask' | 'allow',
): string[] {
  let rules;
  switch (behavior) {
    case 'deny':
      rules = getDenyRules(context);
      break;
    case 'ask':
      rules = getAskRules(context);
      break;
    case 'allow':
      rules = getAllowRules(context);
      break;
    default:
      return [];
  }

  const descriptions: string[] = [];
  for (const rule of rules) {
    if (rule.ruleValue.toolName !== 'Bash') continue;
    const desc = extractPromptDescription(rule.ruleValue.ruleContent);
    if (desc) {
      descriptions.push(desc);
    }
  }
  return descriptions;
}

export function getBashPromptDenyDescriptions(context: ToolPermissionContext): string[] {
  return extractBashPromptDescriptions(context, 'deny');
}

export function getBashPromptAskDescriptions(context: ToolPermissionContext): string[] {
  return extractBashPromptDescriptions(context, 'ask');
}

export function getBashPromptAllowDescriptions(context: ToolPermissionContext): string[] {
  return extractBashPromptDescriptions(context, 'allow');
}

export async function classifyBashCommand(
  _command: string,
  _cwd: string,
  _descriptions: string[],
  _behavior: ClassifierBehavior,
  _signal: AbortSignal,
  _isNonInteractiveSession: boolean,
): Promise<ClassifierResult> {
  return {
    matches: false,
    confidence: 'high',
    reason: 'LLM-based bash classification requires YOLO classifier integration',
  };
}

export async function generateGenericDescription(
  _command: string,
  specificDescription: string | undefined,
  _signal: AbortSignal,
): Promise<string | null> {
  return specificDescription || null;
}

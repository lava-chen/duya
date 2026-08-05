/**
 * Auto-mode LLM classifier domain.
 *
 * Merges the former yoloClassifier, bashClassifier, classifierDecision,
 * denialTracking, autoModeDenials, and autoModeState modules into one.
 * This whole domain is the "auto" permission mode: an LLM-as-judge that
 * decides whether a tool action should be allowed, plus the circuit
 * breaker and denial history that guard it.
 *
 * Note: this module imports getAllowRules/getDenyRules/getAskRules from
 * permissions.ts (the orchestrator), which in turn imports classifyAction
 * from here. That circular reference predates this merge and is harmless
 * because the rule getters are only called at runtime, not at load time.
 */

import type { AIClient } from '@duya/ai';
import type { Message, MessageContent, ToolUseContent, TextContent } from '../types.js';
import type {
  ClassifierUsage,
  ToolPermissionContext,
  YoloClassifierResult,
} from './types.js';
import {
  getAllowRules,
  getDenyRules,
  getAskRules,
} from './permissions.js';

// ============================================================================
// Auto mode runtime state
// ============================================================================

let autoModeActive = false;
let autoModeCircuitBroken = false;

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active;
}

export function isAutoModeActive(): boolean {
  return autoModeActive;
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  autoModeCircuitBroken = broken;
}

export function isAutoModeCircuitBroken(): boolean {
  return autoModeCircuitBroken;
}

// ============================================================================
// Auto mode denial history
// ============================================================================

/**
 * Tracks commands recently denied by the auto mode classifier.
 * Populated from the permission handler, read from the UI for display.
 */
export type AutoModeDenial = {
  toolName: string;
  display: string;
  reason: string;
  timestamp: number;
};

let DENIALS: readonly AutoModeDenial[] = [];
const MAX_DENIALS = 20;

export function recordAutoModeDenial(denial: AutoModeDenial): void {
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)];
}

export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS;
}

// ============================================================================
// Denial tracking (circuit breaker)
// ============================================================================

export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const

export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
  }
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  }
}

export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state
  return {
    ...state,
    consecutiveDenials: 0,
  }
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}

// ============================================================================
// Safe tool allowlist
// ============================================================================

/**
 * Tools that are safe and don't need any classifier checking.
 * Pure read-only or metadata operations with no security risk.
 */
const SAFE_YOLO_ALLOWLISTED_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Task',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'Skill',
  'LSP',
]);

const CANVAS_TOOL_PREFIX = 'canvas_';

export function isAutoModeAllowlistedTool(toolName: string): boolean {
  if (SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)) {
    return true;
  }
  // Conductor tools operate entirely on internal project state; never classify.
  return toolName.startsWith(CANVAS_TOOL_PREFIX) || toolName === 'database_manage';
}

// ============================================================================
// Bash prompt descriptions
// ============================================================================

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

// ============================================================================
// YOLO classifier (LLM-as-judge)
// ============================================================================

const AUTO_MODE_SYSTEM_PROMPT = `You are a security classifier for an AI coding agent. Your job is to review tool actions the agent wants to perform and decide whether each action should be BLOCKED or ALLOWED.

<classification_process>
When reviewing an action:
1. Identify what the action does
2. Check against the block rules below
3. Assess the security risk
4. Decide: block or allow
</classification_process>

<block_rules>
BLOCK actions that:
- Modify files outside the project workspace
- Execute dangerous or destructive shell commands
- Access or transmit sensitive data
- Install unverified software or packages
- Make irreversible changes without explicit user intent
- Access network endpoints not clearly related to the task
- Modify system configuration or environment variables
- Delete or overwrite important project files

ALLOW actions that:
- Read, search, or inspect files within the workspace
- Run standard development tools (build, test, lint, format)
- Execute git commands (status, diff, log, branch)
- Modify files explicitly requested by the user
- Run package managers to install project dependencies
- Access documentation or API references
- Create new files as part of the task
</block_rules>

<user_allow_rules_to_replace>
- Standard development commands (npm install, pip install, cargo build)
- Git operations within the repository
- File modifications matching the user's explicit request
</user_allow_rules_to_replace>

<user_deny_rules_to_replace>
- Commands that delete or modify files outside the project
- System administration commands (shutdown, reboot, etc.)
- Network scanning or penetration testing tools
- Commands that modify user's personal files or settings
</user_deny_rules_to_replace>

<user_environment_to_replace>
- The agent is running in a development environment
- The workspace is a development project directory
</user_environment_to_replace>

<classification_guidelines>
- Err on the side of blocking when uncertain
- Consider the user's explicit intent from the conversation
- Standard development operations are generally safe
- The agent should be able to do its job effectively while staying safe
</classification_guidelines>

## Output Format

If the action should be blocked:
<block>yes</block><reason>one short sentence explaining why</reason>

If the action should be allowed:
<block>no</block>

Do NOT include a <reason> tag when the action is allowed.
Your ENTIRE response MUST begin with <block>. Do NOT output any analysis, reasoning, or commentary before <block>.`;

// ============================================================================
// Transcript Types
// ============================================================================

type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

export type TranscriptEntry = {
  role: 'user' | 'assistant';
  content: TranscriptBlock[];
};

// ============================================================================
// Transcript Building
// ============================================================================

/**
 * Build transcript entries from messages for the classifier.
 *
 * Only includes user text messages and assistant tool_use blocks.
 * Excludes assistant text blocks: model-authored text could be crafted
 * to influence the classifier's decision, making it an attack vector.
 */
export function buildTranscriptEntries(messages: Message[]): TranscriptEntry[] {
  const transcript: TranscriptEntry[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = msg.content;
      const textBlocks: TranscriptBlock[] = [];

      if (typeof content === 'string') {
        textBlocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            textBlocks.push({
              type: 'text',
              text: (block as TextContent).text,
            });
          }
        }
      }

      if (textBlocks.length > 0) {
        transcript.push({ role: 'user', content: textBlocks });
      }
    } else if (msg.role === 'assistant') {
      const content = msg.content;
      if (typeof content === 'string') continue;

      const toolBlocks: TranscriptBlock[] = [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          const toolBlock = block as ToolUseContent;
          toolBlocks.push({
            type: 'tool_use',
            name: toolBlock.name,
            input: toolBlock.input,
          });
        }
      }

      if (toolBlocks.length > 0) {
        transcript.push({ role: 'assistant', content: toolBlocks });
      }
    }
  }

  return transcript;
}

// ============================================================================
// Action Formatting
// ============================================================================

/**
 * Format a pending tool action as a TranscriptEntry for the classifier.
 */
export function formatActionForClassifier(
  toolName: string,
  toolInput: Record<string, unknown>,
): TranscriptEntry {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', name: toolName, input: toolInput }],
  };
}

// ============================================================================
// Compact Serialization
// ============================================================================

function serializeBlock(block: TranscriptBlock, role: string): string {
  if (block.type === 'tool_use') {
    return JSON.stringify({ [block.name]: block.input }) + '\n';
  }
  if (block.type === 'text' && role === 'user') {
    return JSON.stringify({ user: block.text }) + '\n';
  }
  return '';
}

function serializeEntry(entry: TranscriptEntry): string {
  return entry.content.map(b => serializeBlock(b, entry.role)).join('');
}

// ============================================================================
// System Prompt Building
// ============================================================================

/**
 * Build the system prompt for the auto mode classifier.
 * Substitutes user allow/deny/environment rules into the template.
 */
export function buildYoloSystemPrompt(
  context: ToolPermissionContext,
): string {
  const allowDescriptions = getBashPromptAllowDescriptions(context);
  const denyDescriptions = getBashPromptDenyDescriptions(context);

  const userAllow = allowDescriptions.length > 0
    ? allowDescriptions.map(d => `- ${d}`).join('\n')
    : undefined;
  const userDeny = denyDescriptions.length > 0
    ? denyDescriptions.map(d => `- ${d}`).join('\n')
    : undefined;

  return AUTO_MODE_SYSTEM_PROMPT
    .replace(
      /<user_allow_rules_to_replace>([\s\S]*?)<\/user_allow_rules_to_replace>/,
      (_m, defaults: string) => userAllow ?? defaults,
    )
    .replace(
      /<user_deny_rules_to_replace>([\s\S]*?)<\/user_deny_rules_to_replace>/,
      (_m, defaults: string) => userDeny ?? defaults,
    )
    .replace(
      /<user_environment_to_replace>([\s\S]*?)<\/user_environment_to_replace>/,
      (_m, defaults: string) => defaults,
    );
}

// ============================================================================
// XML Parsing
// ============================================================================

function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<thinking>[\s\S]*$/, '');
}

function parseXmlBlock(text: string): boolean | null {
  const matches = [
    ...stripThinking(text).matchAll(/<block>(yes|no)\b(<\/block>)?/gi),
  ];
  if (matches.length === 0) return null;
  return matches[0]![1]!.toLowerCase() === 'yes';
}

function parseXmlReason(text: string): string | null {
  const matches = [
    ...stripThinking(text).matchAll(/<reason>([\s\S]*?)<\/reason>/g),
  ];
  if (matches.length === 0) return null;
  return matches[0]![1]!.trim();
}

// ============================================================================
// Core Classification
// ============================================================================

/**
 * Configuration for the classifier.
 */
export interface YoloClassifierOptions {
  llmClient: AIClient;
  model: string;
  messages: Message[];
  toolName: string;
  toolInput: Record<string, unknown>;
  context: ToolPermissionContext;
  signal: AbortSignal;
}

/**
 * Classify whether a tool action should be blocked in auto mode.
 *
 * Decision flow:
 * 1. Check safe tool allowlist → skip classifier, return allow
 * 2. Build compact transcript from conversation history
 * 3. Build system prompt with rule substitutions
 * 4. Call classifier LLM with XML output format
 * 5. Parse response: <block>yes/no</block>
 * 6. Fail-closed on errors: return shouldBlock: true
 */
export async function classifyAction(
  options: YoloClassifierOptions,
): Promise<YoloClassifierResult> {
  const { llmClient, model, messages, toolName, toolInput, context, signal } = options;

  const overallStart = Date.now();

  if (isAutoModeAllowlistedTool(toolName)) {
    return {
      shouldBlock: false,
      reason: 'Tool is in the safe allowlist',
      model,
      durationMs: Date.now() - overallStart,
    };
  }

  const systemPrompt = buildYoloSystemPrompt(context);

  const transcriptEntries = buildTranscriptEntries(messages);
  const action = formatActionForClassifier(toolName, toolInput);

  let toolCallsLength = 0;
  let userPromptsLength = 0;
  const transcriptLines: string[] = [];

  for (const entry of transcriptEntries) {
    const serialized = serializeEntry(entry);
    if (serialized === '') continue;

    switch (entry.role) {
      case 'user':
        userPromptsLength += serialized.length;
        break;
      case 'assistant':
        toolCallsLength += serialized.length;
        break;
    }
    transcriptLines.push(serialized);
  }

  const actionSerialized = serializeEntry(action);
  toolCallsLength += actionSerialized.length;
  transcriptLines.push(actionSerialized);

  const userPrompt = transcriptLines.join('');
  const promptLengths = {
    systemPrompt: systemPrompt.length,
    toolCalls: toolCallsLength,
    userPrompts: userPromptsLength,
  };

  const userMessageContent = `<transcript>\n${userPrompt}</transcript>\n\nErr on the side of blocking. <block> immediately.`;

  try {
    if (!llmClient.chat) {
      throw new Error('LLM client does not support non-streaming chat');
    }

    const classifierMessage: Message = {
      role: 'user',
      content: userMessageContent,
    };

    const result = await llmClient.chat(
      [classifierMessage],
      {
        systemPrompt,
        maxTokens: 256,
        temperature: 0,
        signal,
      },
    );

    const durationMs = Date.now() - overallStart;
    const block = parseXmlBlock(result.content);
    const reason = parseXmlReason(result.content);

    if (block === null) {
      return {
        shouldBlock: true,
        reason: 'Classifier response unparseable - blocking for safety',
        model,
        usage: usageFromTokenUsage(result.usage),
        durationMs,
        promptLengths,
      };
    }

    return {
      shouldBlock: block,
      reason: reason ?? (block ? 'Blocked by classifier' : 'Allowed by classifier'),
      model,
      usage: usageFromTokenUsage(result.usage),
      durationMs,
      promptLengths,
    };
  } catch (error) {
    const durationMs = Date.now() - overallStart;

    if (signal.aborted) {
      return {
        shouldBlock: true,
        reason: 'Classifier request aborted',
        model,
        unavailable: true,
        durationMs,
        promptLengths,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      shouldBlock: true,
      reason: `Classifier unavailable: ${errorMessage} - blocking for safety`,
      model,
      unavailable: true,
      durationMs,
      promptLengths,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

function usageFromTokenUsage(
  usage?: { input_tokens: number; output_tokens: number; cache_hit_tokens?: number; cache_creation_tokens?: number },
): ClassifierUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_hit_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_tokens ?? 0,
  };
}
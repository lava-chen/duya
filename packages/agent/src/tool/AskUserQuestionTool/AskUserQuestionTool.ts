/**
 * AskUserQuestionTool - Prompt the user with multi-choice questions
 *
 * Architecture:
 *  1. LLM calls this tool with { questions: [...] }
 *  2. First execution returns <tool_use_permission_required> marker
 *     StreamingToolExecutor detects this → calls requestPermission() → frontend shows UI
 *  3. User answers → answers stored in module-level map by toolUseId
 *  4. StreamingToolExecutor retries execution → tool reads stored answers
 *  5. Answers returned as a structured "User has answered..." ToolResult → LLM continues
 *
 * Adapted from claude-code-haha's AskUserQuestionTool.
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, PermissionCheckResult, ToolContext } from '../types.js';
import type { ToolUseContext } from '../../types.js';
import { z } from 'zod';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  DESCRIPTION,
} from './prompt.js';

// ============================================================
// Zod Schema
// ============================================================

const questionOptionSchema = z.object({
  label: z.string().describe('Display text for the option (1-5 words)'),
  description: z.string().describe('Explanation of what this option means'),
});

const questionSchema = z.object({
  question: z.string().describe('The complete question to ask. Should be clear, specific, and end with a question mark.'),
  header: z.string().max(12).describe('Very short label (max 12 chars). Examples: "Auth method", "Library", "Approach".'),
  options: z.array(questionOptionSchema).min(2).max(4).describe('2-4 options'),
  multiSelect: z.boolean().default(false).describe('Set to true to allow multiple answers'),
});

/**
 * Model inputs occasionally arrive as a wrapper `{ def: "<json string>" }`
 * or with `questions`/per-question `options` serialized as JSON strings.
 * Unwrap that before Zod sees it so we don't reject valid calls.
 */
function unwrapDef(val: unknown): unknown {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if (Object.keys(obj).length === 1 && 'def' in obj && typeof obj.def === 'string') {
      try {
        return JSON.parse(obj.def);
      } catch {
        return val;
      }
    }
  }
  return val;
}

const UNIQUENESS_REFINE = {
  check: (data: { questions: Array<{ question: string; options: Array<{ label: string }> }> }) => {
    const questions = data.questions.map((q) => q.question);
    if (questions.length !== new Set(questions).size) {
      return false;
    }
    for (const question of data.questions) {
      const labels = question.options.map((opt) => opt.label);
      if (labels.length !== new Set(labels).size) {
        return false;
      }
    }
    return true;
  },
  message: 'Question texts must be unique, option labels must be unique within each question',
} as const;

export const askUserQuestionInputSchema = z.preprocess(
  (val) => {
    let obj = unwrapDef(val);
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      const record = { ...(obj as Record<string, unknown>) };
      if (typeof record.questions === 'string') {
        try {
          record.questions = JSON.parse(record.questions as string);
        } catch {
          /* leave as-is, let zod report the original error */
        }
      }
      if (Array.isArray(record.questions)) {
        record.questions = (record.questions as unknown[]).map((q) => {
          if (typeof q === 'object' && q !== null) {
            const qo = { ...(q as Record<string, unknown>) };
            if (typeof qo.options === 'string') {
              try {
                qo.options = JSON.parse(qo.options as string);
              } catch {
                /* leave as-is */
              }
            }
            return qo;
          }
          return q;
        });
      }
      return record;
    }
    return obj;
  },
  z
    .object({
      questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .describe('1-4 questions to ask the user'),
    })
    .strict()
    .refine(UNIQUENESS_REFINE.check, { message: UNIQUENESS_REFINE.message }),
);

export type AskUserQuestionInput = z.infer<typeof askUserQuestionInputSchema>;

// ============================================================
// Answer Storage (module-level, persists across retries)
// ============================================================

const pendingAnswers = new Map<string, Record<string, string>>();

/**
 * Store resolved answers keyed by permission request id.
 * Called from agent-process-entry when permission:resolve arrives with updatedInput.
 */
export function storePendingAnswer(permissionId: string, answers: Record<string, string>): void {
  pendingAnswers.set(permissionId, answers);
}

export function clearPendingAnswer(permissionId: string): void {
  pendingAnswers.delete(permissionId);
}

// ============================================================
// Legacy JSON Schema (for SDK / wire-format consumers)
// ============================================================

/**
 * Plain JSON Schema mirror of the Zod input — kept for tool definitions
 * exported to SDK callers that don't consume Zod. Mirrors the same
 * strictness as the Zod schema (no additionalProperties).
 */
const JSON_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      description: '1-4 questions to ask the user',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: {
            type: 'string',
            description: 'The complete question to ask. Should be clear, specific, and end with a question mark.',
          },
          header: {
            type: 'string',
            maxLength: 12,
            description: 'Very short label (max 12 chars). Examples: "Auth method", "Library", "Approach".',
          },
          options: {
            type: 'array',
            description: '2-4 options',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: {
                  type: 'string',
                  description: 'Display text for the option (1-5 words)',
                },
                description: {
                  type: 'string',
                  description: 'Explanation of what this option means',
                },
              },
              required: ['label', 'description'],
            },
          },
          multiSelect: {
            type: 'boolean',
            default: false,
            description: 'Set to true to allow multiple answers',
          },
        },
        required: ['question', 'header', 'options', 'multiSelect'],
      },
    },
  },
  required: ['questions'],
};

// ============================================================
// LLM-facing Result Formatting
// ============================================================

/**
 * Format answers for the LLM, mirroring claude-code-haha's
 * `mapToolResultToToolResultBlockParam`:
 *   User has answered your questions: "Q1"="A1", "Q2"="A2". You can now
 *   continue with the user's answers in mind.
 */
function formatAnswersForLLM(
  questions: Array<{ question: string; header: string }>,
  answers: Record<string, string>,
): string {
  const parts: string[] = [];
  for (const q of questions) {
    const answer = answers[q.question];
    if (answer !== undefined) {
      parts.push(`"${q.question}"="${answer}"`);
    }
  }
  if (parts.length === 0) {
    return 'User has answered your questions, but no answers were captured. Ask the user again to clarify.';
  }
  return `User has answered your questions: ${parts.join(', ')}. You can now continue with the user's answers in mind.`;
}

// ============================================================
// Tool Implementation
// ============================================================

export class AskUserQuestionTool extends BaseTool {
  readonly name = ASK_USER_QUESTION_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema = JSON_INPUT_SCHEMA;

  isConcurrencySafe(): boolean {
    return true;
  }

  /**
   * Always allows permission — the tool itself IS the user interaction.
   * The actual ask/response flow runs through the `ask_user_question`
   * permission mode surfaced by `checkPermissions` → requestPermission.
   */
  checkPermissions(_input: unknown, _context: ToolContext): PermissionCheckResult {
    return {
      allowed: true,
      requiresUserConfirmation: false,
    };
  }

  /**
   * Two-phase execution:
   *
   * Phase 1 (no answer stored yet):
   *   Returns <tool_use_permission_required> marker with questions data.
   *   StreamingToolExecutor detects this and triggers the permission_request flow.
   *
   * Phase 2 (answer stored, on retry after user responded):
   *   Reads stored answers and returns them as a structured tool result to the LLM.
   */
  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const parsed = askUserQuestionInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: context?.toolUseId || crypto.randomUUID(),
        name: this.name,
        result: `Input validation failed: ${parsed.error.message}`,
        error: true,
      };
    }

    const toolUseId = context?.toolUseId || crypto.randomUUID();

    // Phase 2: Check if answers are already stored (retry after user responded)
    const answers = pendingAnswers.get(toolUseId);
    if (answers) {
      pendingAnswers.delete(toolUseId);
      return {
        id: toolUseId,
        name: this.name,
        result: formatAnswersForLLM(parsed.data.questions, answers),
      };
    }

    // Phase 1: Trigger permission_request with ask_user_question mode
    const permissionPayload = {
      id: toolUseId,
      toolName: this.name,
      toolInput: parsed.data,
      mode: 'ask_user_question' as const,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    return {
      id: toolUseId,
      name: this.name,
      result: `<tool_use_permission_required>${JSON.stringify(permissionPayload)}</tool_use_permission_required>`,
      metadata: {
        permissionInfo: permissionPayload,
      },
    };
  }

  generateUserFacingDescription(input: unknown): string {
    try {
      const parsed = askUserQuestionInputSchema.parse(input);
      const headers = parsed.questions.map((q) => q.header).join(', ');
      return `${this.name}: [${headers}]`;
    } catch {
      return this.name;
    }
  }
}

export const askUserQuestionTool = new AskUserQuestionTool();

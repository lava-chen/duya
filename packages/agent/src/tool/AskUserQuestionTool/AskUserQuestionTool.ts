/**
 * AskUserQuestionTool - Prompt the user with multi-choice questions
 *
 * Architecture:
 *  1. LLM calls this tool with { questions: [...] }
 *  2. First execution returns <tool_use_permission_required> marker
 *     StreamingToolExecutor detects this → calls requestPermission() → frontend shows UI
 *  3. User answers → answers stored in module-level map by toolUseId
 *  4. StreamingToolExecutor retries execution → tool reads stored answers
 *  5. Answers returned as tool_result → LLM continues with user input
 *
 * Adapted from claude-code-haha's AskUserQuestionTool
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult, PermissionCheckResult, ToolContext } from '../types.js';
import type { ToolUseContext } from '../../types.js';
import { z } from 'zod';

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';

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

export const askUserQuestionInputSchema = z.preprocess(
  (val) => {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      const obj = { ...(val as Record<string, unknown>) };
      if (typeof obj.questions === 'string') {
        try {
          obj.questions = JSON.parse(obj.questions as string);
        } catch {
          /* leave as-is, let zod report the original error */
        }
      }
      if (Array.isArray(obj.questions)) {
        obj.questions = (obj.questions as unknown[]).map((q) => {
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
      return obj;
    }
    return val;
  },
  z.object({
    questions: z.array(questionSchema).min(1).max(4).describe('1-4 questions to ask the user'),
  }),
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
// Tool Description
// ============================================================

const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Keep questions concise and clear
- Limit to 1-4 questions per call`;

// ============================================================
// Tool Implementation
// ============================================================

export class AskUserQuestionTool extends BaseTool {
  readonly name = ASK_USER_QUESTION_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema = askUserQuestionInputSchema;

  isConcurrencySafe(): boolean {
    return true;
  }

  /**
   * Always requires user interaction — this tool IS the interaction.
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
   *   Reads stored answers and returns them as tool result to LLM.
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
        result: JSON.stringify({ error: `Input validation failed: ${parsed.error.message}` }),
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
        result: JSON.stringify({
          questions: parsed.data.questions.map((q) => ({
            question: q.question,
            header: q.header,
          })),
          answers,
        }),
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
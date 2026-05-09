/**
 * SkillManageTool - Manage skills (create, update, delete)
 *
 * Provides the agent with the ability to create, update, and delete skills.
 * Mirrors hermes-agent's skill_manage tool.
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../types.js';
import type { ToolExecutor } from './registry.js';
import { skillManage, type SkillManageParams } from '../skills/SkillManager.js';

const inputSchema = z.object({
  action: z.enum(['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'draft', 'promote', 'reject']).describe('The action to perform.'),
  name: z.string().describe('Skill name (lowercase, hyphens/underscores, max 64 chars). Must match an existing skill for patch/edit/delete/write_file/remove_file.'),
  content: z.string().optional().describe('Full SKILL.md content (YAML frontmatter + markdown body). Required for \'create\' and \'draft\'. Optional for \'edit\' when doing full rewrite.'),
  old_string: z.string().optional().describe('Text to find in the file (required for \'patch\', optional for \'edit\'). When used with \'edit\', performs patch-style edit on SKILL.md.'),
  new_string: z.string().optional().describe('Replacement text (required for \'patch\', optional for \'edit\'). Can be empty string to delete matched text.'),
  replace_all: z.boolean().optional().describe('For \'patch\': replace all occurrences (default: false).'),
  category: z.string().optional().describe('Optional category/domain for organizing the skill (e.g., \'devops\', \'data-science\'). Only used with \'create\' and \'draft\'.'),
  file_path: z.string().optional().describe('Path to a supporting file within the skill directory. Used with \'patch\' to patch supporting files instead of SKILL.md.'),
  file_content: z.string().optional().describe('Content for the file. Required for \'write_file\'.'),
});

export type SkillManageInput = z.infer<typeof inputSchema>;

/**
 * SkillManageTool - Tool for managing user-created skills
 */
export class SkillManageTool implements Tool, ToolExecutor {
  readonly name = 'skill_manage';
  readonly description = `Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types. New skills go to ~/.duya/skills/; existing skills can be modified wherever they live.

Actions:
- create: Create new skill with full SKILL.md content (requires 'content' with YAML frontmatter + body, optional 'category')
- draft: Create skill in draft/ directory for evaluation (requires 'content' with YAML frontmatter + body)
- patch: Targeted find-and-replace (requires 'old_string' and 'new_string'). Use for small fixes. Can patch SKILL.md or supporting files (use 'file_path').
- edit: Update SKILL.md. Supports TWO modes:
  * Full rewrite: provide 'content' with complete YAML frontmatter + body
  * Patch-style: provide 'old_string' and 'new_string' to replace specific text in SKILL.md
- delete: Remove entire skill
- write_file: Add/overwrite supporting file (requires 'file_path' and 'file_content')
- remove_file: Remove supporting file (requires 'file_path')
- promote: Move draft skill to ~/.duya/skills/
- reject: Delete draft skill

Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.
Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.
Draft when: creating skills via self-improvement system (skills are created in ~/.duya/skills-draft/ for evaluation).
Promote when: a draft skill has been evaluated and approved (moves to ~/.duya/skills/).
Reject when: a draft skill failed evaluation and should be deleted.

After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.

Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps. Use skill_view() to see format examples.`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'patch', 'edit', 'delete', 'write_file', 'remove_file', 'draft', 'promote', 'reject'],
        description: 'The action to perform.',
      },
      name: {
        type: 'string',
        description: 'Skill name (lowercase, hyphens/underscores, max 64 chars). Must match an existing skill for patch/edit/delete/write_file/remove_file.',
      },
      content: {
        type: 'string',
        description: 'Full SKILL.md content (YAML frontmatter + markdown body). Required for \'create\' and \'draft\'. Optional for \'edit\' when doing full rewrite.',
      },
      old_string: {
        type: 'string',
        description: 'Text to find in the file. Required for \'patch\'. Optional for \'edit\' (enables patch-style edit on SKILL.md).',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text. Required for \'patch\'. Optional for \'edit\'. Can be empty string to delete matched text.',
      },
      replace_all: {
        type: 'boolean',
        description: 'For \'patch\': replace all occurrences (default: false).',
      },
      category: {
        type: 'string',
        description: 'Optional category/domain for organizing the skill. Only used with \'create\' and \'draft\'.',
      },
      file_path: {
        type: 'string',
        description: 'Path to a supporting file within the skill directory. Used with \'patch\' to patch supporting files instead of SKILL.md.',
      },
      file_content: {
        type: 'string',
        description: 'Content for the file. Required for \'write_file\'.',
      },
    },
    required: ['action', 'name'],
  };

  readonly interruptBehavior = 'block' as const;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  /**
   * Execute skill_manage
   */
  async execute(input: Record<string, unknown>, _workingDirectory?: string): Promise<ToolResult> {
    const parseResult = inputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: false,
          error: `Invalid input: ${parseResult.error.message}`,
        }),
        error: true,
      };
    }

    const params: SkillManageParams = {
      action: parseResult.data.action,
      name: parseResult.data.name,
      content: parseResult.data.content,
      old_string: parseResult.data.old_string,
      new_string: parseResult.data.new_string,
      replace_all: parseResult.data.replace_all,
      category: parseResult.data.category,
      file_path: parseResult.data.file_path,
      file_content: parseResult.data.file_content,
    };

    const result = await skillManage(params);

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
      error: !result.success,
    };
  }

  /**
   * Required by Tool interface but not used directly
   */
  async call(input: unknown, _context: ToolUseContext): Promise<ToolResult> {
    return this.execute(input as Record<string, unknown>);
  }

  /**
   * Required by Tool interface
   */
  validateInput(input: unknown): { success: boolean; data?: unknown; error?: string } {
    const result = inputSchema.safeParse(input);
    if (!result.success) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.data };
  }

  /**
   * Required by Tool interface
   */
  isConcurrencySafe(): boolean {
    return true;
  }

  /**
   * Required by Tool interface
   */
  renderToolResultMessage(result: ToolResult): { type: string; content: string; metadata?: Record<string, unknown> } {
    try {
      const parsed = JSON.parse(result.result);
      if (parsed.success) {
        return { type: 'text', content: parsed.message || 'Skill operation completed.' };
      } else {
        return { type: 'error', content: parsed.error || 'Skill operation failed.' };
      }
    } catch {
      return { type: 'text', content: result.result };
    }
  }

  /**
   * Required by Tool interface
   */
  generateUserFacingDescription(input: unknown): string {
    const params = input as Record<string, unknown>;
    return `skill_manage(action=${params.action}, name=${params.name})`;
  }
}

// Export singleton instance
export const skillManageTool = new SkillManageTool();

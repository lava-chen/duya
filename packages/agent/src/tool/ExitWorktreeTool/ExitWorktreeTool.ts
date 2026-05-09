/**
 * ExitWorktreeTool - Exit and remove a git worktree
 * Adapted from claude-code-haha for duya
 */

import { execa } from 'execa';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

export interface ExitWorktreeInput {
  name: string;
}

export class ExitWorktreeTool implements Tool, ToolExecutor {
  readonly name = EXIT_WORKTREE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the worktree to exit',
      },
    },
    required: ['name'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { name } = input as unknown as ExitWorktreeInput;

    if (!name) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'name is required' }),
        error: true,
      };
    }

    const worktreePath = `.worktrees/${name}`;

    try {
      // Check if we're in a git repository
      await execa('git', ['rev-parse', '--git-dir'], { shell: true });

      // Check if worktree exists
      const listResult = await execa('git', ['worktree', 'list', '--porcelain'], { shell: true });
      if (!listResult.stdout.includes(worktreePath)) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({ error: `Worktree ${name} not found at ${worktreePath}` }),
          error: true,
        };
      }

      // Remove the worktree
      await execa('git', ['worktree', 'remove', worktreePath], { shell: true });

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          worktreeName: name,
          message: `Exited and removed worktree ${name}`,
        }),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to exit worktree',
        }),
        error: true,
      };
    }
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const exitWorktreeTool = new ExitWorktreeTool();

/**
 * EnterWorktreeTool - Enter a git worktree
 * Adapted from claude-code-haha for duya
 */

import { execa } from 'execa';
import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

export interface EnterWorktreeInput {
  name?: string;
  branch: string;
  path?: string;
}

export class EnterWorktreeTool implements Tool, ToolExecutor {
  readonly name = ENTER_WORKTREE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the worktree (optional, defaults to branch name)',
      },
      branch: {
        type: 'string',
        description: 'Branch name for the worktree',
      },
      path: {
        type: 'string',
        description: 'Path where to create the worktree (optional, defaults to .worktrees/<name>)',
      },
    },
    required: ['branch'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { name, branch, path } = input as unknown as EnterWorktreeInput;

    if (!branch) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'branch is required' }),
        error: true,
      };
    }

    const worktreeName = name || branch;
    const worktreePath = path || `.worktrees/${worktreeName}`;

    try {
      // Check if we're in a git repository
      await execa('git', ['rev-parse', '--git-dir'], { shell: true });

      // Check if worktree already exists
      const listResult = await execa('git', ['worktree', 'list', '--porcelain'], { shell: true });
      if (listResult.stdout.includes(worktreePath)) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({ error: `Worktree already exists at ${worktreePath}` }),
          error: true,
        };
      }

      // Create and enter the worktree
      await execa('git', ['worktree', 'add', '-b', branch, worktreePath], { shell: true });

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          worktreeName,
          worktreePath,
          branch,
          message: `Entered worktree ${worktreeName} at ${worktreePath}`,
        }),
      };
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to enter worktree',
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
export const enterWorktreeTool = new EnterWorktreeTool();

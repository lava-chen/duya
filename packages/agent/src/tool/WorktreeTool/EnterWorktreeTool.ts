/**
 * EnterWorktreeTool — move the live session into an isolated git worktree
 * (plan 441, aligned to Claude Code's main-session EnterWorktree).
 *
 * All git orchestration is reused from the plan 440 WorktreeManager. The
 * switch is immediate for the caller: subsequent tool executions in the same
 * turn read the live `options.workingDirectory` getter, and every following
 * turn re-reads DuyaAgent's workingDirectory through the `setWorkingDirectory`
 * callback wired at context construction.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { createAgentWorktree } from '../../worktree/worktree-manager.js';
import { getSessionWorktree, setSessionWorktree } from '../../worktree/worktree-session.js';
import { persistSessionWorkingDirectory } from './persistSessionDirectory.js';
import { logger } from '../../utils/logger.js';

export const ENTER_WORKTREE_TOOL_NAME = 'enter_worktree';

function toResult(name: string, payload: unknown, error?: boolean): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export class EnterWorktreeTool implements Tool, ToolExecutor {
  readonly name = ENTER_WORKTREE_TOOL_NAME;
  readonly description =
    'Move this session into an isolated git worktree (fresh base commit + dedicated branch) so subsequent work cannot disturb the current working copy. Use when a long-running task should stay isolated from parallel changes; exit with exit_worktree when done.';

  readonly input_schema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Short name for the worktree (letters, digits, dots, underscores, dashes). A random name is generated when omitted.',
      },
      base_ref: {
        type: 'string',
        enum: ['fresh', 'head'],
        description:
          "'fresh' (default) branches from origin's default branch for a deterministic base; 'head' branches from the current HEAD to keep local continuity.",
        default: 'fresh',
      },
    },
    required: [],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, context?: ToolUseContext): Promise<ToolResult> {
    const sessionId = context?.options.sessionId;
    if (!sessionId) {
      return toResult(this.name, 'enter_worktree requires a session context (options.sessionId).', true);
    }
    if (!context?.setWorkingDirectory) {
      return toResult(
        this.name,
        'Agent runtime does not expose setWorkingDirectory; cannot switch the session working directory.',
        true,
      );
    }

    const existing = getSessionWorktree(sessionId);
    if (existing) {
      return toResult(this.name, {
        outcome: 'already_in_worktree',
        worktree: { path: existing.handle.path, branch: existing.handle.branch },
        message: `Already inside worktree ${existing.handle.path}. Use exit_worktree first (action "keep" or "remove").`,
      }, true);
    }

    const repoDir = context.options.workingDirectory ?? process.cwd();
    const { name, base_ref: baseRef } = input as {
      name?: string;
      base_ref?: 'fresh' | 'head';
    };

    try {
      const handle = await createAgentWorktree({ repoDir, name, baseRef });
      setSessionWorktree(sessionId, { handle, previousWorkingDirectory: repoDir });
      context.setWorkingDirectory(handle.path);
      await persistSessionWorkingDirectory(sessionId, handle.path);
      logger.info('[Worktree] session entered worktree', {
        sessionId,
        path: handle.path,
        branch: handle.branch,
        previousWorkingDirectory: repoDir,
      }, 'Worktree');
      return toResult(this.name, {
        outcome: 'entered',
        worktree: { path: handle.path, branch: handle.branch, base_commit: handle.baseCommit },
        previous_working_directory: repoDir,
        message:
          'Session now runs inside this isolated worktree: file changes land on the dedicated branch and never touch the previous directory. When done, call exit_worktree with action "keep" (retain tree + branch) or "remove" (delete both; refuses when dirty unless force).',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[Worktree] enter_worktree failed', err as Error, { sessionId, repoDir }, 'Worktree');
      return toResult(this.name, {
        outcome: 'create_failed',
        message: `Failed to create worktree: ${message}`,
      }, true);
    }
  }
}

export const enterWorktreeTool = new EnterWorktreeTool();

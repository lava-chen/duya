/**
 * ExitWorktreeTool — leave the worktree the session currently occupies
 * (plan 441, aligned to Claude Code's ExitWorktree keep/remove semantics).
 *
 * - `keep` (default): restore the previous directory, retain tree + branch.
 * - `remove`: delete tree + branch. A dirty tree is refused with a typed
 *   outcome unless `force` is set — real work is never silently discarded.
 *
 * On any successful exit the working directory is restored to where the
 * session was before entering, in-memory and in the persisted session row.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import {
  isAgentWorktreeDirty,
  removeAgentWorktree,
} from '../../worktree/worktree-manager.js';
import { clearSessionWorktree, getSessionWorktree } from '../../worktree/worktree-session.js';
import { persistSessionWorkingDirectory } from './persistSessionDirectory.js';
import { logger } from '../../utils/logger.js';

export const EXIT_WORKTREE_TOOL_NAME = 'exit_worktree';

function toResult(name: string, payload: unknown, error?: boolean): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: typeof payload === 'string' ? payload : JSON.stringify(payload),
    ...(error ? { error: true } : {}),
  };
}

export class ExitWorktreeTool implements Tool, ToolExecutor {
  readonly name = EXIT_WORKTREE_TOOL_NAME;
  readonly description =
    "Leave the git worktree this session entered via enter_worktree and restore the previous working directory. action 'keep' (default) retains the worktree and its branch; action 'remove' deletes both, refusing when uncommitted changes exist unless force is true.";

  readonly input_schema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description:
          "'keep' (default) restores the directory but retains the worktree and branch for later merge; 'remove' also deletes them.",
        default: 'keep',
      },
      force: {
        type: 'boolean',
        description:
          "With action 'remove': discard uncommitted changes in the worktree instead of refusing. Only after explicit user confirmation.",
        default: false,
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
      return toResult(this.name, 'exit_worktree requires a session context (options.sessionId).', true);
    }
    if (!context?.setWorkingDirectory) {
      return toResult(
        this.name,
        'Agent runtime does not expose setWorkingDirectory; cannot restore the session working directory.',
        true,
      );
    }

    const entry = getSessionWorktree(sessionId);
    if (!entry) {
      return toResult(this.name, {
        outcome: 'not_in_worktree',
        message: 'This session has not entered a worktree (nothing to exit).',
      }, true);
    }

    const { handle, previousWorkingDirectory } = entry;
    const { action = 'keep', force = false } = input as {
      action?: 'keep' | 'remove';
      force?: boolean;
    };

    const restoreDirectory = async (): Promise<string> => {
      const dir = previousWorkingDirectory ?? process.cwd();
      context.setWorkingDirectory!(dir);
      await persistSessionWorkingDirectory(sessionId, dir);
      clearSessionWorktree(sessionId);
      return dir;
    };

    if (action !== 'remove') {
      let dirty: boolean | null = null;
      try {
        dirty = await isAgentWorktreeDirty(handle.path);
      } catch {
        dirty = null; // Unreadable tree — still safe to keep.
      }
      const restoredTo = await restoreDirectory();
      logger.info('[Worktree] session exited worktree (kept)', {
        sessionId,
        path: handle.path,
        branch: handle.branch,
        restoredTo,
      }, 'Worktree');
      return toResult(this.name, {
        outcome: 'kept',
        worktree: { path: handle.path, branch: handle.branch },
        dirty,
        restored_to: restoredTo,
        message:
          'Previous directory restored. The worktree and its branch are retained — commit or merge from that branch when ready.',
      });
    }

    // Typed dirty check first so the refusal is actionable rather than a raw
    // git error string; a clean tree needs no force at all.
    let dirty = false;
    try {
      dirty = await isAgentWorktreeDirty(handle.path);
    } catch {
      dirty = false; // Fall through and let git itself refuse if something is off.
    }
    if (dirty && !force) {
      return toResult(this.name, {
        outcome: 'refused_dirty',
        worktree: { path: handle.path, branch: handle.branch },
        message:
          'Worktree has uncommitted changes. Use action "keep" to retain them, or pass force:true (after explicit user confirmation) to discard.',
      }, true);
    }

    const outcome = await removeAgentWorktree(handle, { force: dirty || force });
    if (!outcome.removed) {
      return toResult(this.name, {
        outcome: 'remove_failed',
        worktree: { path: handle.path, branch: handle.branch },
        reason: outcome.reason,
        message: 'The worktree is still active; nothing was deleted.',
      }, true);
    }
    const restoredTo = await restoreDirectory();
    logger.info('[Worktree] session exited worktree (removed)', {
      sessionId,
      path: handle.path,
      branch: handle.branch,
      restoredTo,
    }, 'Worktree');
    return toResult(this.name, {
      outcome: 'removed',
      worktree: { path: handle.path, branch: handle.branch },
      restored_to: restoredTo,
      message: 'Worktree and branch deleted; previous working directory restored.',
    });
  }
}

export const exitWorktreeTool = new ExitWorktreeTool();

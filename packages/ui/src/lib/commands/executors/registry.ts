/**
 * Command Executor Registry & Dispatch
 *
 * Executors are plain functions `(ctx) => CommandResult` registered by domain
 * module (info/model/auth/session/view). The registry is intentionally
 * separate from `CommandDef.execute`: registry entries are metadata for the
 * popover/help, executors are the runtime dispatch table — several commands
 * may share a domain file without touching the metadata registry.
 *
 * Dispatch order for a parsed command:
 *   1. `CommandDef.execute` (per-definition override, rarely used)
 *   2. registered executor for the command name
 *   3. fallback: forward the raw input to the agent
 *
 * `runSlashCommand` never throws — it converts executor errors into
 * `{ type: 'error' }` results so the composer can surface them.
 */

import type { CommandContext, CommandResult } from '../types';
import { parseCommand } from '../parser';
import { getCommandAppBridge } from './bridge';

export type CommandExecutorFn = (
  ctx: CommandContext
) => CommandResult | Promise<CommandResult>;

const EXECUTORS = new Map<string, CommandExecutorFn>();

/** Register a batch of executors (called once at module load by domain files). */
export function registerCommandExecutors(map: Record<string, CommandExecutorFn>): void {
  for (const [name, fn] of Object.entries(map)) {
    if (typeof fn === 'function') EXECUTORS.set(name, fn);
  }
}

/** True when a runtime executor exists for the command name (no slash). */
export function hasCommandExecutor(name: string): boolean {
  return EXECUTORS.has(name);
}

/** Look up a registered executor (no slash). */
export function getCommandExecutor(name: string): CommandExecutorFn | undefined {
  return EXECUTORS.get(name);
}

/**
 * Execute a slash-command input like `/model gpt-4` or `/goal status`.
 *
 * Returns:
 * - the executor's CommandResult,
 * - `{ type: 'forward', prompt: input }` when the command is unknown or has
 *   no executor (caller sends it to the agent as plain text),
 * - `{ type: 'error' }` when the bridge is missing or the executor throws.
 */
export async function runSlashCommand(input: string): Promise<CommandResult> {
  const parsed = parseCommand(input);
  if (!parsed) {
    return { type: 'forward', prompt: input };
  }

  const executor = parsed.command.execute ?? EXECUTORS.get(parsed.command.name);
  if (!executor) {
    return { type: 'forward', prompt: input };
  }

  const app = getCommandAppBridge();
  if (!app) {
    return { type: 'error', message: `/${parsed.command.name}: app bridge unavailable` };
  }

  try {
    return await executor({
      args: parsed.args,
      raw: parsed.raw,
      app,
    });
  } catch (error) {
    return {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

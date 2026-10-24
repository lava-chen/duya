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
 *
 * ## The availability gate
 *
 * Before the executor runs, the shared catalog is asked whether the command
 * can run right now (`commandAvailability`). It answers from two facts the
 * bridge knows — is there a session, is a turn streaming — and the catalog's
 * own `requiresSession` / `availableWhileBusy` declarations.
 *
 * This is the one place the answer is produced, so a command that mutates the
 * conversation mid-turn is refused the same way on the Desktop as it is in the
 * CLI TUI ("press Esc first"). Without the gate, `availableWhileBusy` was a
 * declaration nothing read: the Desktop advertised commands as unsafe to run
 * while busy and then ran them anyway.
 */

import { commandAvailability, findSpec } from '@duya/command-catalog';

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
 * - `{ type: 'error' }` when the bridge is missing, the command cannot run
 *   right now, or the executor throws.
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

  const refusal = availabilityRefusal(parsed.command.name, app);
  if (refusal) return refusal;

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

/**
 * The catalog's verdict for this command at this moment, or null when it may
 * run.
 *
 * The spec is looked up by the CANONICAL name: the user may have typed an
 * alias, and it is the canonical command whose availability is declared.
 */
function availabilityRefusal(
  canonicalName: string,
  app: NonNullable<ReturnType<typeof getCommandAppBridge>>,
): CommandResult | null {
  const spec = findSpec(canonicalName);
  if (spec === undefined) return null;

  const snapshot = app.getSessionSnapshot();
  const verdict = commandAvailability(spec, {
    hasSession: Boolean(snapshot.sessionId),
    busy: snapshot.isStreaming === true,
  });
  if (verdict.available) return null;
  return { type: 'error', message: verdict.reason };
}

/**
 * Command Parser
 *
 * Parses command input and resolves to execution.
 */

import type { CommandContext, CommandResult, CommandDef } from './types';
import { resolveCommand } from './registry';

// ============================================================================
// Parsed Command
// ============================================================================

export interface ParsedCommand {
  command: CommandDef;
  name: string;
  args: string[];
  raw: string;
}

// ============================================================================
// Parse
// ============================================================================

/**
 * Parse a command input string.
 * Returns null if not a valid command.
 */
export function parseCommand(input: string): ParsedCommand | null {
  if (!input.startsWith('/')) return null;

  const spaceIndex = input.indexOf(' ');
  const raw = spaceIndex === -1 ? input : input.slice(0, spaceIndex);
  const name = raw.slice(1).toLowerCase();
  const args = spaceIndex === -1 ? [] : input.slice(spaceIndex + 1).split(/\s+/);

  const command = resolveCommand(raw);
  if (!command) return null;

  return { command, name, args, raw };
}

/**
 * Check if input looks like a command (starts with /).
 */
export function isCommandLike(input: string): boolean {
  return input.startsWith('/');
}

/**
 * Extract command name from input without full parsing.
 */
export function extractCommandName(input: string): string | null {
  if (!input.startsWith('/')) return null;
  const spaceIndex = input.indexOf(' ');
  return spaceIndex === -1
    ? input.slice(1).toLowerCase()
    : input.slice(1, spaceIndex).toLowerCase();
}

// ============================================================================
// Execute
// ============================================================================

/**
 * Default execute implementations for built-in commands.
 * These are the App-side handlers.
 */
export const DEFAULT_EXECUTORS: Record<string, (ctx: CommandContext) => CommandResult | Promise<CommandResult>> = {
  help: () => ({ type: 'dismiss' }),  // Handled by UI
  status: () => ({ type: 'dismiss' }),  // Handled by UI
  cost: () => ({ type: 'dismiss' }),  // Handled by UI
  clear: (ctx) => {
    ctx.clearMessages?.();
    return { type: 'dismiss' };
  },
  new: async (ctx) => {
    if (ctx.resetSession) {
      const result = await ctx.resetSession();
      return { type: 'session_reset', newSessionId: result.newSessionId };
    }
    return { type: 'dismiss' };
  },
  compact: (ctx) => ({ type: 'forward', prompt: '/compact' }),
  memory: (ctx) => ({ type: 'forward', prompt: '/memory' }),
  export: (ctx) => ({ type: 'forward', prompt: '/export' }),
  model: (ctx) => ({ type: 'forward', prompt: ctx.args.length ? `/model ${ctx.args.join(' ')}` : '/model' }),
  review: (ctx) => ({ type: 'forward', prompt: 'Use the /review skill.' }),
  simplify: (ctx) => ({ type: 'forward', prompt: 'Use the /simplify skill.' }),
  doctor: (ctx) => ({ type: 'forward', prompt: 'Use the /doctor skill.' }),
  commit: (ctx) => ({ type: 'forward', prompt: 'Use the /commit skill.' }),
  plan: (ctx) => ({ type: 'forward', prompt: 'Use the /plan skill.' }),
};

/**
 * Execute a parsed command.
 */
export async function executeCommand(
  parsed: ParsedCommand,
  ctx: CommandContext
): Promise<CommandResult> {
  const executor = parsed.command.execute ?? DEFAULT_EXECUTORS[parsed.command.name];
  if (!executor) {
    // Fallback: forward to agent
    return { type: 'forward', prompt: parsed.raw };
  }
  return executor(ctx);
}

/**
 * Execute a command by name (looks up and executes).
 */
export async function executeByName(
  input: string,
  ctx: CommandContext
): Promise<CommandResult | null> {
  const parsed = parseCommand(input);
  if (!parsed) return null;
  return executeCommand(parsed, ctx);
}

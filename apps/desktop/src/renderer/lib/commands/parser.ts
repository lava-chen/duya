/**
 * Command Parser
 *
 * Parses command input into a resolved command definition.
 *
 * Execution lives elsewhere: `lib/commands/executors/registry.ts` owns the
 * runtime dispatch table (`runSlashCommand`). This file is parse-only.
 */

import type { CommandDef } from './types';
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

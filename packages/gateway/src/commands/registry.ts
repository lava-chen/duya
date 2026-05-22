/**
 * Gateway Command Registry
 *
 * Gateway-specific command definitions.
 * These are kept separate from App commands because the gateway runs
 * in a separate process and cannot import from src/.
 */

import type { CommandDef } from './types.js';

// ============================================================================
// Gateway Commands
// ============================================================================

const GATEWAY_COMMANDS: CommandDef[] = [
  {
    name: 'new',
    aliases: ['reset'],
    description: 'Start a new session',
    category: 'session',
  },
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show available commands',
    category: 'info',
  },
  {
    name: 'status',
    description: 'Show session info',
    category: 'info',
  },
  {
    name: 'pair',
    description: 'Request pairing code for approval',
    category: 'pairing',
  },
];

// ============================================================================
// Lookups
// ============================================================================

export type { CommandDef, CommandContext, CommandResult, CommandPlatform, CommandCategory, HelpEntry, HelpSection } from './types.js';

export const COMMAND_REGISTRY: readonly CommandDef[] = GATEWAY_COMMANDS;

/**
 * Resolve a command by name or alias.
 */
export function resolveCommand(input: string): CommandDef | null {
  const name = input.toLowerCase().replace(/^\//, '');
  return COMMAND_REGISTRY.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name)
  ) ?? null;
}

/**
 * Get all command names and aliases for gateway.
 */
export function getCommandNamesForPlatform(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const cmd of COMMAND_REGISTRY) {
    names.add(cmd.name);
    cmd.aliases?.forEach((a) => names.add(a));
  }
  return names;
}

export const GATEWAY_KNOWN_COMMANDS: ReadonlySet<string> = getCommandNamesForPlatform();

/**
 * Check if a command is known by the gateway.
 */
export function isGatewayKnownCommand(name: string): boolean {
  const normalized = name.toLowerCase().replace(/^\//, '');
  return GATEWAY_KNOWN_COMMANDS.has(normalized);
}
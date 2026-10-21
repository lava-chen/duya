/**
 * Gateway Command Registry
 *
 * Gateway-specific command definitions.
 * These are kept separate from App commands because the gateway runs
 * in a separate process and cannot import from src/.
 *
 * The registry is split into two parts:
 *   1. GATEWAY_COMMANDS - the built-in, static command set.
 *   2. DYNAMIC_COMMANDS - runtime-registered commands (e.g. installed skills
 *      exposed as slash commands) appended via `registerDynamicCommands()`.
 */

import type { CommandDef } from './types.js';

// ============================================================================
// Gateway Commands
// ============================================================================

const GATEWAY_COMMANDS: CommandDef[] = [
  // --- Session control ---
  {
    name: 'new',
    aliases: ['reset'],
    description: 'Start a new session',
    category: 'session',
  },
  {
    name: 'clear',
    description: 'Clear the screen and start a new session',
    category: 'session',
  },
  {
    name: 'retry',
    description: 'Resend the last user message',
    category: 'session',
  },
  {
    name: 'undo',
    description: 'Remove the last user/assistant exchange',
    category: 'session',
  },
  {
    name: 'stop',
    description: 'Stop the current stream/session',
    category: 'session',
  },
  {
    name: 'save',
    description: 'Save the current session',
    category: 'session',
  },
  {
    name: 'sessions',
    description: 'List available sessions',
    category: 'session',
  },
  {
    name: 'resume',
    description: 'Resume a session by name',
    argsHint: '[name]',
    category: 'session',
  },
  {
    name: 'history',
    description: 'Show a summary of the current session history',
    category: 'session',
  },
  {
    name: 'title',
    description: 'Set the session title',
    argsHint: '<name>',
    category: 'session',
  },

  // --- Info / help ---
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show available commands',
    category: 'info',
  },
  {
    name: 'commands',
    description: 'List all available commands (including dynamic)',
    category: 'info',
  },
  {
    name: 'status',
    description: 'Show session info',
    category: 'info',
  },
  {
    name: 'about',
    description: 'Show bot introduction',
    category: 'info',
  },

  // --- Model / provider ---
  {
    name: 'model',
    description: 'Show or switch the current model',
    argsHint: '[provider:model]',
    category: 'model',
  },
  {
    name: 'provider',
    description: 'Show the current provider',
    category: 'model',
  },
  {
    name: 'reasoning',
    description: 'Toggle or show reasoning display',
    category: 'model',
  },

  // --- Context / usage ---
  {
    name: 'usage',
    description: 'Show context/usage estimate',
    category: 'context',
  },
  {
    name: 'compress',
    description: 'Trigger context compression',
    argsHint: '[here [N] | focus topic]',
    category: 'context',
  },
  {
    name: 'position',
    description: 'Show context position/cursor',
    category: 'context',
  },
  {
    name: 'insights',
    description: 'Show usage insights',
    argsHint: '[days]',
    category: 'context',
  },

  // --- Account / config ---
  {
    name: 'whoami',
    description: 'Show current user id and role in the group',
    category: 'account',
  },
  {
    name: 'profile',
    description: 'Show the current profile name and home directory',
    category: 'config',
  },
  {
    name: 'sethome',
    description: 'Set the current chat as the home channel',
    category: 'config',
  },

  // --- Personality / voice ---
  {
    name: 'personality',
    description: 'Show or change the agent personality',
    argsHint: '[name]',
    category: 'model',
  },
  {
    name: 'voice',
    description: 'Control messaging voice replies',
    argsHint: '[on|off|tts|status]',
    category: 'voice',
  },

  // --- Background / rollback / steer ---
  {
    name: 'background',
    description: 'Run a prompt in a separate background session',
    argsHint: '<prompt>',
    category: 'session',
  },
  {
    name: 'rollback',
    description: 'List or restore filesystem checkpoints',
    argsHint: '[number]',
    category: 'context',
  },
  {
    name: 'steer',
    description: 'Inject a message into the current run',
    argsHint: '<message>',
    category: 'session',
  },

  // --- Display / fast mode ---
  {
    name: 'fast',
    description: 'Toggle fast mode',
    argsHint: '[on|off]',
    category: 'model',
  },
  {
    name: 'verbose',
    description: 'Toggle detailed tool progress',
    argsHint: '[on|off]',
    category: 'context',
  },

  // --- Maintenance / lifecycle ---
  {
    name: 'reload-mcp',
    description: 'Reload MCP servers from config',
    category: 'config',
  },
  {
    name: 'update',
    description: 'Update DUYA to the latest version',
    category: 'config',
  },
  {
    name: 'delete',
    description: 'Delete the current session',
    category: 'session',
  },
];

// ============================================================================
// Dynamic commands (runtime-registered, e.g. installed skills)
// ============================================================================

const DYNAMIC_COMMANDS: CommandDef[] = [];

/**
 * Register dynamically-provided commands at runtime (e.g. installed skills
 * surfaced as slash commands). Appended after the built-in registry so a
 * dynamic command can shadow a built-in one if the names collide.
 */
export function registerDynamicCommands(list: readonly CommandDef[]): void {
  for (const cmd of list) {
    if (!cmd?.name) continue;
    const idx = DYNAMIC_COMMANDS.findIndex((c) => c.name === cmd.name);
    if (idx >= 0) DYNAMIC_COMMANDS[idx] = cmd;
    else DYNAMIC_COMMANDS.push(cmd);
  }
}

/** Clear all runtime-registered dynamic commands. */
export function clearDynamicCommands(): void {
  DYNAMIC_COMMANDS.length = 0;
}

/** Get the full command set (built-in + dynamic). */
export function getAllCommands(): readonly CommandDef[] {
  return [...GATEWAY_COMMANDS, ...DYNAMIC_COMMANDS];
}

// ============================================================================
// Lookups
// ============================================================================

export type { CommandDef, CommandContext, CommandResult, CommandPlatform, CommandCategory, HelpEntry, HelpSection } from './types.js';

/**
 * Static built-in command list. Kept for backward compatibility with callers
 * that only need the baked-in commands (e.g. telegram adapter /commands
 * menu). For a full view use `getAllCommands()`.
 */
export const COMMAND_REGISTRY: readonly CommandDef[] = GATEWAY_COMMANDS;

/**
 * Resolve a command by name or alias (built-in or dynamic).
 */
export function resolveCommand(input: string): CommandDef | null {
  const name = input.toLowerCase().replace(/^\//, '');
  return getAllCommands().find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name)
  ) ?? null;
}

/**
 * Get all command names and aliases for gateway (built-in + dynamic).
 */
export function getCommandNamesForPlatform(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const cmd of getAllCommands()) {
    names.add(cmd.name);
    cmd.aliases?.forEach((a) => names.add(a));
  }
  return names;
}

export const GATEWAY_KNOWN_COMMANDS: ReadonlySet<string> = getCommandNamesForPlatform();

/**
 * Check if a command is known by the gateway (built-in or dynamic).
 */
export function isGatewayKnownCommand(name: string): boolean {
  const normalized = name.toLowerCase().replace(/^\//, '');
  return getCommandNamesForPlatform().has(normalized);
}
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
 *
 * ## Every command here must be executable
 *
 * The gateway only DETECTS commands. Execution happens Main-side, in
 * `handleGatewayCommand` (`apps/desktop/src/main/gateway/message-bus.ts`), and
 * anything without a Main-side implementation falls into that function's
 * `default:` branch and answers `尚未在此构建中启用`.
 *
 * That fallback is a good last resort, but it is not a substitute for being in
 * the registry at all: `COMMAND_REGISTRY` is what the Telegram adapter uploads
 * as the bot's `/commands` menu (`adapters/telegram/index.ts`), and
 * `generateHelpText` lists the same set in `/help`. A command the Main process
 * cannot run must therefore not be advertised — the user would tap it from a
 * menu that the product itself published.
 *
 * So this list is deliberately the set Main-side actually implements:
 * `help` / `new` / `reset` / `clear` / `stop` / `status`. Adding a command
 * here means adding its Main-side case in the same change.
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
    name: 'stop',
    description: 'Stop the current stream/session',
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
    name: 'status',
    description: 'Show session info',
    category: 'info',
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
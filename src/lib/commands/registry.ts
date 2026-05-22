/**
 * Command Registry
 *
 * Central registry for all slash commands. Single source of truth for:
 * - CLI (processed in App)
 * - Gateway (processed in platform adapters)
 *
 * Usage:
 *   import { resolveCommand, getCommandsForPlatform, COMMAND_REGISTRY } from '@/lib/commands/registry';
 */

import type { CommandDef, CommandPlatform, CommandContext, CommandResult } from './types';

// ============================================================================
// Built-in Commands
// ============================================================================

const BUILT_IN_COMMANDS: CommandDef[] = [
  // ========================================================================
  // Session
  // ========================================================================
  {
    name: 'new',
    aliases: ['reset'],
    description: 'Start a new session',
    category: 'session',
    argsHint: '',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    category: 'session',
    platforms: ['app'],
    requiresSession: false,
  },
  {
    name: 'compact',
    description: 'Compress conversation context to save tokens',
    category: 'session',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'memory',
    description: 'View or manage session memory',
    category: 'session',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'export',
    description: 'Export conversation to markdown/json/html',
    category: 'session',
    argsHint: '[format]',
    platforms: ['app'],
    requiresSession: true,
  },

  // ========================================================================
  // Info
  // ========================================================================
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show available commands',
    category: 'info',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'status',
    description: 'Show session info',
    category: 'info',
    platforms: ['app', 'gateway'],
    requiresSession: false,
  },
  {
    name: 'cost',
    description: 'Show token usage statistics and estimated costs',
    category: 'info',
    platforms: ['app'],
    requiresSession: true,
  },

  // ========================================================================
  // Config
  // ========================================================================
  {
    name: 'model',
    description: 'Switch model for this session',
    category: 'config',
    argsHint: '[model]',
    platforms: ['app'],
    requiresSession: false,
  },

  // ========================================================================
  // Tools & Skills
  // ========================================================================
  {
    name: 'review',
    description: 'Review code changes with detailed feedback',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'simplify',
    description: 'Simplify and refactor complex code',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'doctor',
    description: 'Diagnose project issues and suggest fixes',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'commit',
    description: 'Generate smart Git commit messages',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
  {
    name: 'plan',
    description: 'Enter planning mode for complex tasks',
    category: 'tools',
    platforms: ['app'],
    requiresSession: true,
  },
];

// ============================================================================
// Export
// ============================================================================

export const COMMAND_REGISTRY: readonly CommandDef[] = BUILT_IN_COMMANDS;

// ============================================================================
// Lookups
// ============================================================================

/**
 * Resolve a command name or alias to its CommandDef.
 * Accepts names with or without leading slash.
 */
export function resolveCommand(input: string): CommandDef | null {
  const name = input.toLowerCase().replace(/^\//, '');
  return COMMAND_REGISTRY.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name)
  ) ?? null;
}

/**
 * Get all commands available for a specific platform.
 */
export function getCommandsForPlatform(platform: CommandPlatform): readonly CommandDef[] {
  return COMMAND_REGISTRY.filter(
    (cmd) => !cmd.platforms || cmd.platforms.includes(platform)
  );
}

/**
 * Get all command names and aliases for a platform (for quick lookup).
 */
export function getCommandNamesForPlatform(platform: CommandPlatform): ReadonlySet<string> {
  const names = new Set<string>();
  for (const cmd of getCommandsForPlatform(platform)) {
    names.add(cmd.name);
    cmd.aliases?.forEach((a) => names.add(a));
  }
  return names;
}

/**
 * Check if a command is known for a platform.
 */
export function isKnownCommand(input: string, platform: CommandPlatform): boolean {
  const name = input.toLowerCase().replace(/^\//, '');
  return getCommandNamesForPlatform(platform).has(name);
}

/**
 * Get commands grouped by category.
 */
export function getCommandsByCategory(platform: CommandPlatform): Map<string, CommandDef[]> {
  const map = new Map<string, CommandDef[]>();
  for (const cmd of getCommandsForPlatform(platform)) {
    const existing = map.get(cmd.category) ?? [];
    existing.push(cmd);
    map.set(cmd.category, existing);
  }
  return map;
}

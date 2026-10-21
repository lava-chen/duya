/**
 * Command Registry
 *
 * The Desktop's view of `@duya/command-catalog`. Definitions live in that
 * package so the CLI TUI and this composer cannot drift apart; this file maps
 * a catalog spec onto the renderer's `CommandDef` and answers lookups.
 *
 * Behaviour is NOT shared, and deliberately so: the Desktop's executors act on
 * a renderer-side `CommandAppBridge` (`executors/`), while the CLI's act over
 * the Host HTTP API. codex splits the same way — `slash_command.rs` holds the
 * definition and its `description()`, `slash_dispatch.rs` holds the behavior.
 *
 * Usage:
 *   import { resolveCommand, getCommandsForPlatform, COMMAND_REGISTRY } from '@/lib/commands/registry';
 */

import { COMMAND_SPECS, findSpec, type CommandSpec } from '@duya/command-catalog';

import type { CommandDef, CommandPlatform } from './types';

// ============================================================================
// Catalog -> CommandDef
// ============================================================================

/**
 * Project a catalog spec onto the renderer's definition.
 *
 * Deliberately NOT filtered by session or busy state: this list feeds the
 * popup, `/help` and lookup, and hiding a command here would turn "not
 * advertised" into "unknown command" for anyone who types it. The catalog's
 * `specsForSurface` exists for surfaces that genuinely want a filtered menu;
 * this one does not, because the Desktop already decided what to show.
 */
function toCommandDef(spec: CommandSpec): CommandDef {
  return {
    name: spec.name,
    aliases: spec.aliases === undefined ? undefined : [...spec.aliases],
    label: spec.label,
    labelZh: spec.labelZh,
    description: spec.description,
    descriptionZh: spec.descriptionZh,
    category: spec.category,
    argsHint: spec.argsHint,
    subcommands: spec.subcommands === undefined ? undefined : [...spec.subcommands],
    // Gateway is a Desktop-side transport rather than a front end, so the
    // catalog carries it as a flag on the command instead of a surface.
    platforms: spec.gateway === true ? ['app', 'gateway'] : ['app'],
    requiresSession: spec.requiresSession === true,
  };
}

/**
 * Desktop-advertised commands, in the catalog's declared order — which is the
 * popup's presentation order.
 */
const BUILT_IN_COMMANDS: CommandDef[] = COMMAND_SPECS.filter((spec) =>
  spec.surfaces.includes('desktop'),
).map(toCommandDef);

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
 *
 * Falls back to the catalog so a command the popup does not list still resolves
 * and runs its executor, instead of being forwarded to the model as prose.
 */
export function resolveCommand(input: string): CommandDef | null {
  const name = input.toLowerCase().replace(/^\//, '').trim();
  const local = COMMAND_REGISTRY.find(
    (cmd) => cmd.name === name || cmd.aliases?.includes(name)
  );
  if (local) return local;
  const spec = findSpec(name);
  if (spec === undefined) return null;
  return toCommandDef(spec);
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
  const name = input.toLowerCase().replace(/^\//, '').trim();
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

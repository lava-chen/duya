/**
 * Help Text Generation
 *
 * Generates help output for commands.
 */

import type { CommandCategory, CommandPlatform, HelpEntry, HelpSection } from './types';
import { getCommandsForPlatform } from './registry';

// ============================================================================
// Category Labels
// ============================================================================

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: 'Session',
  config: 'Configuration',
  info: 'Info',
  tools: 'Tools & Skills',
  exit: 'Exit',
};

// ============================================================================
// Help Text Generation
// ============================================================================

/**
 * Format a single command for help display.
 */
function formatCommand(cmd: HelpEntry): string {
  const args = cmd.argsHint ? ` ${cmd.argsHint}` : '';
  const name = `/${cmd.name}${args}`;
  const aliasPart = cmd.aliases?.length
    ? ` (alias: ${cmd.aliases.map((a) => `/${a}`).join(', ')})`
    : '';
  return `\`${name}\` - ${cmd.description}${aliasPart}`;
}

/**
 * Format a category section for help display.
 */
function formatSection(section: HelpSection): string {
  const header = `**${CATEGORY_LABELS[section.category]}**`;
  const entries = section.entries.map(formatCommand).join('\n');
  return `${header}\n${entries}`;
}

/**
 * Generate help text for a platform.
 */
export function generateHelpText(platform: CommandPlatform = 'app'): string {
  const commands = getCommandsForPlatform(platform);

  // Group by category
  const sections = new Map<CommandCategory, HelpEntry[]>();
  for (const cmd of commands) {
    const entries = sections.get(cmd.category) ?? [];
    entries.push({
      name: cmd.name,
      description: cmd.description,
      argsHint: cmd.argsHint,
      aliases: cmd.aliases,
    });
    sections.set(cmd.category, entries);
  }

  // Format sections in order
  const order: CommandCategory[] = ['session', 'config', 'info', 'tools', 'exit'];
  const lines: string[] = ['*Available Commands:*\n'];

  for (const cat of order) {
    const entries = sections.get(cat);
    if (!entries?.length) continue;
    lines.push('');
    lines.push(formatSection({ category: cat, entries }));
  }

  return lines.join('\n');
}

/**
 * Generate short help text (single line per command, grouped by category).
 */
export function generateCompactHelpText(platform: CommandPlatform = 'app'): string {
  const commands = getCommandsForPlatform(platform);

  // Group by category
  const sections = new Map<CommandCategory, string[]>();
  for (const cmd of commands) {
    const lines = sections.get(cmd.category) ?? [];
    const name = cmd.argsHint ? `${cmd.name} ${cmd.argsHint}` : cmd.name;
    lines.push(`\`/${name}\``);
    sections.set(cmd.category, lines);
  }

  const order: CommandCategory[] = ['session', 'config', 'info', 'tools', 'exit'];
  const result: string[] = [];

  for (const cat of order) {
    const lines = sections.get(cat);
    if (!lines?.length) continue;
    result.push(`${CATEGORY_LABELS[cat]}: ${lines.join(' ')}`);
  }

  return result.join('\n');
}

/**
 * Generate help text for a specific command.
 */
export function getCommandHelp(name: string): string | null {
  const commands = getCommandsForPlatform('app');
  const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name));

  if (!cmd) return null;

  const args = cmd.argsHint ? ` ${cmd.argsHint}` : '';
  let help = `**/${cmd.name}${args}**\n${cmd.description}`;

  if (cmd.aliases?.length) {
    help += `\n\nAliases: ${cmd.aliases.map((a) => `/${a}`).join(', ')}`;
  }

  return help;
}

/**
 * Get help sections for UI rendering.
 */
export function getHelpSections(platform: CommandPlatform = 'app'): HelpSection[] {
  const commands = getCommandsForPlatform(platform);

  const sectionMap = new Map<CommandCategory, HelpEntry[]>();
  for (const cmd of commands) {
    const entries = sectionMap.get(cmd.category) ?? [];
    entries.push({
      name: cmd.name,
      description: cmd.description,
      argsHint: cmd.argsHint,
      aliases: cmd.aliases,
    });
    sectionMap.set(cmd.category, entries);
  }

  const order: CommandCategory[] = ['session', 'config', 'info', 'tools', 'exit'];
  const sections: HelpSection[] = [];

  for (const cat of order) {
    const entries = sectionMap.get(cat);
    if (!entries?.length) continue;
    sections.push({ category: cat, entries });
  }

  return sections;
}
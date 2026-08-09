/**
 * Help Text Generation for Gateway
 *
 * Generates help output for gateway commands.
 */

import type { CommandCategory } from './types.js';
import { getAllCommands } from './registry.js';

// ============================================================================
// Category Labels
// ============================================================================

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: 'Session',
  config: 'Configuration',
  info: 'Info',
  tools: 'Tools & Skills',
  exit: 'Exit',
  pairing: 'Pairing',
  model: 'Model',
  context: 'Context & Usage',
  account: 'Account',
  voice: 'Voice',
};

// ============================================================================
// Help Text Generation
// ============================================================================

/**
 * Generate help text for gateway commands.
 */
export function generateHelpText(platform: 'app' | 'gateway' = 'gateway'): string {
  // Filter commands by platform if specified. Includes dynamic commands.
  const commands = platform === 'gateway'
    ? getAllCommands()
    : getAllCommands();

  // Group by category
  const sections = new Map<CommandCategory, { name: string; description: string; argsHint?: string; aliases?: readonly string[] }[]>();
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
  const order: CommandCategory[] = ['session', 'config', 'info', 'tools', 'exit', 'pairing', 'model', 'context', 'account', 'voice'];
  const lines: string[] = ['*Available Commands:*\n'];

  for (const cat of order) {
    const entries = sections.get(cat);
    if (!entries?.length) continue;
    lines.push('');

    const header = `**${CATEGORY_LABELS[cat]}**`;
    const entryLines = entries.map((entry) => {
      const usage = entry.argsHint ? ` ${entry.argsHint}` : '';
      const aliasPart = entry.aliases?.length
        ? ` (alias: ${entry.aliases.map((a) => `/${a}`).join(', ')})`
        : '';
      return `\`/${entry.name}${usage}\` - ${entry.description}${aliasPart}`;
    });

    lines.push(header);
    lines.push(entryLines.join('\n'));
  }

  return lines.join('\n');
}

/**
 * Get help for a specific command.
 */
export function getCommandHelp(name: string): string | null {
  const cmd = getAllCommands().find(
    (c) => c.name === name || c.aliases?.includes(name)
  );
  if (!cmd) return null;

  let help = `**/${cmd.name}**\n${cmd.description}`;
  if (cmd.aliases?.length) {
    help += `\n\nAliases: ${cmd.aliases.map((a) => `/${a}`).join(', ')}`;
  }
  return help;
}
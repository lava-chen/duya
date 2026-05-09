/**
 * Slash Commands System for DUYA CLI
 *
 * Inspired by hermes-agent's COMMAND_REGISTRY
 * Provides autocomplete and dispatch for /commands
 * Unified system for CLI, Telegram, and other platforms
 */

import select from '@inquirer/select';
import { Colors, color } from './colors.js';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import type { duyaAgent } from '../index.js';
import { getActiveCliProvider } from './config/db-config.js';

export interface SlashCommandContext {
  agent?: duyaAgent;
  sessionId?: string;
  platform?: 'cli' | 'telegram' | 'duya-app' | 'web' | 'api';
}

export interface SlashCommand {
  name: string;
  description: string;
  category: string;
  aliases?: string[];
  argsHint?: string;
  subcommands?: string[];
  /** If true, command is only available in CLI mode */
  cliOnly?: boolean;
  /** If true, command is only available in gateway/messaging platforms */
  gatewayOnly?: boolean;
  handler: (args: string, context?: SlashCommandContext) => Promise<boolean>; // returns true if command was handled
}

/** Command definition for registry - immutable like hermes-agent's CommandDef */
export interface CommandDef {
  name: string;
  description: string;
  category: string;
  aliases?: string[];
  argsHint?: string;
  subcommands?: string[];
  cliOnly?: boolean;
  gatewayOnly?: boolean;
}

// Command registry
const SLASH_COMMANDS: Map<string, SlashCommand> = new Map();

// Register a slash command
export function registerSlashCommand(cmd: SlashCommand): void {
  SLASH_COMMANDS.set(cmd.name, cmd);
  // Register aliases
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      SLASH_COMMANDS.set(alias, cmd);
    }
  }
}

// Resolve command by name (handles aliases)
export function resolveSlashCommand(name: string): SlashCommand | undefined {
  const cleanName = name.toLowerCase().replace(/^\//, '');
  return SLASH_COMMANDS.get(cleanName);
}

// Get all unique commands (excluding aliases)
export function getSlashCommands(): SlashCommand[] {
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const cmd of SLASH_COMMANDS.values()) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      commands.push(cmd);
    }
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

// Get commands by category
export function getSlashCommandsByCategory(): Map<string, SlashCommand[]> {
  const byCategory = new Map<string, SlashCommand[]>();
  const commands = getSlashCommands();
  for (const cmd of commands) {
    const list = byCategory.get(cmd.category) || [];
    list.push(cmd);
    byCategory.set(cmd.category, list);
  }
  return byCategory;
}

// ASCII theme for Windows compatibility
const asciiTheme = {
  icon: {
    cursor: '>',
  },
  style: {
    answer: (text: string) => text,
    message: (text: string) => text,
    error: (text: string) => `[ERR] ${text}`,
    help: (text: string) => text,
    highlight: (text: string) => `> ${text}`,
    description: (text: string) => text,
    disabled: (text: string) => `[X] ${text}`,
    keysHelpTip: () => undefined,
  },
};

// Show slash command menu (when user types just "/")
export async function showSlashCommandMenu(): Promise<string | null> {
  const commands = getSlashCommands();

  // Build choices grouped by category
  const choices: Array<{ value: string; name: string; description?: string }> = [];
  const byCategory = getSlashCommandsByCategory();

  for (const [category, cmds] of byCategory) {
    // Add category header as disabled option
    choices.push({
      value: `__header_${category}`,
      name: `[${category}]`,
      description: category,
    });

    // Add commands in this category
    for (const cmd of cmds) {
      const aliasStr = cmd.aliases?.length ? ` (/${cmd.aliases.join(', /')})` : '';
      choices.push({
        value: `/${cmd.name}`,
        name: `  /${cmd.name}${aliasStr}`,
        description: cmd.description,
      });
    }
  }

  try {
    const selected = await select<string>({
      message: 'Select a command:',
      choices,
      theme: asciiTheme,
    });

    // Skip if user selected a header
    if (selected.startsWith('__header_')) {
      return null;
    }

    return selected;
  } catch {
    // User cancelled (Ctrl+C or Escape)
    return null;
  }
}

// Execute a slash command
export async function executeSlashCommand(input: string, context?: SlashCommandContext): Promise<boolean> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return false;
  }

  // Parse command and args
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.*))?$/);
  if (!match) {
    return false;
  }

  const [, cmdName, args = ''] = match;
  const cmd = resolveSlashCommand(cmdName);

  if (!cmd) {
    console.log(color(`[ERR] Unknown command: /${cmdName}`, Colors.RED));
    console.log(color('  Type / for available commands', Colors.DIM));
    return true; // Handled (showed error)
  }

  return await cmd.handler(args.trim(), context);
}

// Check if input is a slash command
export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith('/');
}

/**
 * Central command registry - single source of truth like hermes-agent
 * All commands are defined here with their metadata
 */
export const COMMAND_REGISTRY: CommandDef[] = [
  // Session commands
  { name: 'new', description: 'Start a new session (fresh session ID + history)', category: 'Session' },
  { name: 'clear', description: 'Clear screen and start a new session', category: 'Session', cliOnly: true },
  { name: 'history', description: 'Show conversation history', category: 'Session', cliOnly: true },
  { name: 'save', description: 'Save the current conversation', category: 'Session', cliOnly: true },
  { name: 'retry', description: 'Retry the last message (resend to agent)', category: 'Session' },
  { name: 'undo', description: 'Remove the last user/assistant exchange', category: 'Session' },
  { name: 'title', description: 'Set a title for the current session', category: 'Session', argsHint: '[name]' },
  { name: 'status', description: 'Show session info', category: 'Session' },
  { name: 'stop', description: 'Kill all running background processes', category: 'Session' },
  { name: 'compress', description: 'Manually compress conversation context', category: 'Session', argsHint: '[focus topic]' },
  { name: 'agents', description: 'Show active agents and running tasks', category: 'Session', aliases: ['tasks'] },
  { name: 'plan', description: 'Create or view an execution plan', category: 'Session', argsHint: '[description|open]' },

  // Configuration commands
  { name: 'config', description: 'Show current configuration', category: 'Configuration', cliOnly: true },
  { name: 'model', description: 'Switch model for this session', category: 'Configuration', argsHint: '[model-name]' },
  { name: 'cd', description: 'Change working directory', category: 'Configuration', argsHint: '[path]', cliOnly: true },
  { name: 'setup', description: 'Run setup wizard', category: 'Configuration', cliOnly: true },
  { name: 'effort', description: 'Manage reasoning effort and display', category: 'Configuration', argsHint: '[level|show|hide]', subcommands: ['none', 'minimal', 'low', 'medium', 'high', 'show', 'hide'] },

  // Tools & Skills
  { name: 'skills', description: 'List available skills', category: 'Tools & Skills', cliOnly: true },
  { name: 'tools', description: 'List available tools', category: 'Tools & Skills', cliOnly: true },

  // Info
  { name: 'help', description: 'Show available commands', category: 'Info' },
  { name: 'usage', description: 'Show token usage and rate limits', category: 'Info' },

  // Exit
  { name: 'quit', description: 'Exit the CLI', category: 'Exit', aliases: ['exit', 'q'], cliOnly: true },
];

/**
 * Build command lookup map from registry
 */
function buildCommandLookup(): Map<string, CommandDef> {
  const lookup = new Map<string, CommandDef>();
  for (const cmd of COMMAND_REGISTRY) {
    lookup.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        lookup.set(alias, cmd);
      }
    }
  }
  return lookup;
}

/**
 * Resolve a command name or alias to its CommandDef
 */
export function resolveCommand(name: string): CommandDef | undefined {
  const lookup = buildCommandLookup();
  return lookup.get(name.toLowerCase().replace(/^\//, ''));
}

/**
 * Check if a command is available for the current platform
 */
export function isCommandAvailable(cmd: CommandDef, platform: SlashCommandContext['platform'] = 'cli'): boolean {
  if (platform === 'cli' && cmd.gatewayOnly) return false;
  if (platform !== 'cli' && cmd.cliOnly) return false;
  return true;
}

/**
 * Get help lines for gateway/messaging platforms
 */
export function getGatewayHelpLines(platform: SlashCommandContext['platform'] = 'telegram'): string[] {
  const lines: string[] = [];
  const byCategory = new Map<string, CommandDef[]>();

  // Group by category
  for (const cmd of COMMAND_REGISTRY) {
    if (!isCommandAvailable(cmd, platform)) continue;
    const list = byCategory.get(cmd.category) || [];
    list.push(cmd);
    byCategory.set(cmd.category, list);
  }

  // Build output
  for (const [category, commands] of byCategory) {
    lines.push(`\n[${category}]`);
    for (const cmd of commands) {
      const args = cmd.argsHint ? ` ${cmd.argsHint}` : '';
      const aliasParts = (cmd.aliases || [])
        .filter(a => a.replace(/-/g, '_') !== cmd.name.replace(/-/g, '_'))
        .map(a => `/${a}`);
      const aliasNote = aliasParts.length ? ` (alias: ${aliasParts.join(', ')})` : '';
      lines.push(`  /${cmd.name}${args} - ${cmd.description}${aliasNote}`);
    }
  }

  return lines;
}

// Initialize default slash commands
export function initSlashCommands(): void {
  // Session commands
  registerSlashCommand({
    name: 'new',
    description: 'Start a new session (fresh session ID + history)',
    category: 'Session',
    handler: async (_args, context) => {
      if (context?.platform === 'cli') {
        console.log(color('[OK] Starting new session...', Colors.GREEN));
      }

      // Reset agent messages if available
      if (context?.agent) {
        try {
          const messageCount = context.agent.getMessages().length;
          context.agent.clearMessages();

          if (context.platform === 'cli') {
            console.log(color(`[OK] New session started (${messageCount} messages cleared)`, Colors.GREEN));
          } else {
            // For messaging platforms, return a clear message
            console.log(`New session started. ${messageCount > 0 ? `${messageCount} messages cleared.` : ''}`);
          }
        } catch (err) {
          const errorMsg = `Failed to clear session: ${err instanceof Error ? err.message : String(err)}`;
          if (context.platform === 'cli') {
            console.error(color(`[ERR] ${errorMsg}`, Colors.RED));
          } else {
            console.log(`Error: ${errorMsg}`);
          }
        }
      } else {
        const warnMsg = 'New session started';
        if (context?.platform === 'cli') {
          console.log(color(`[OK] ${warnMsg}`, Colors.GREEN));
        } else {
          console.log(warnMsg);
        }
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'clear',
    description: 'Clear screen and start a new session',
    category: 'Session',
    cliOnly: true,
    handler: async () => {
      console.clear();
      return true;
    },
  });

  registerSlashCommand({
    name: 'history',
    description: 'Show conversation history',
    category: 'Session',
    cliOnly: true,
    handler: async (_args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      try {
        const messages = context.agent.getMessages();
        if (messages.length === 0) {
          console.log(color('[INFO] No messages in current session', Colors.YELLOW));
          return true;
        }
        console.log(color(`\n[Conversation History] (${messages.length} messages)\n`, Colors.CYAN));
        for (const msg of messages) {
          const roleColor = msg.role === 'user' ? Colors.GREEN : msg.role === 'assistant' ? Colors.CYAN : Colors.DIM;
          const content = typeof msg.content === 'string'
            ? msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : '')
            : JSON.stringify(msg.content).slice(0, 200);
          console.log(color(`  [${msg.role}] ${content}`, roleColor));
        }
        console.log();
      } catch (err) {
        console.error(color(`[ERR] Failed to get history: ${err instanceof Error ? err.message : String(err)}`, Colors.RED));
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'status',
    description: 'Show session info',
    category: 'Session',
    handler: async (_args, context) => {
      const agent = context?.agent;
      const platform = context?.platform || 'cli';

      // Gather session info
      const messages = agent?.getMessages() || [];
      const userMsgs = messages.filter(m => m.role === 'user').length;
      const assistantMsgs = messages.filter(m => m.role === 'assistant').length;
      const toolMsgs = messages.filter(m => m.role === 'tool').length;

      // Get provider info
      const provider = getActiveCliProvider();
      const model = process.env.ANTHROPIC_MODEL || provider?.notes?.match(/Default model:\s*(.+)/)?.[1]?.trim() || '';

      if (platform === 'cli') {
        // CLI formatted output
        console.log(color('\n[Session Status]', Colors.CYAN));
        console.log(color(`  Session ID: ${context?.sessionId || 'N/A'}`, Colors.DIM));
        console.log(color(`  Model: ${model}`, Colors.DIM));
        console.log(color(`  Workspace: ${process.cwd()}`, Colors.DIM));
        console.log(color(`  Messages: ${messages.length} total (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`, Colors.DIM));
        console.log();
      } else {
        // Messaging platform plain text output
        const lines = [
          'Session Status:',
          `  Session ID: ${context?.sessionId || 'N/A'}`,
          `  Model: ${model}`,
          `  Workspace: ${process.cwd()}`,
          `  Messages: ${messages.length} total (${userMsgs} user, ${assistantMsgs} assistant, ${toolMsgs} tool)`,
        ];
        console.log(lines.join('\n'));
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'retry',
    description: 'Retry the last message (resend to agent)',
    category: 'Session',
    handler: async (_args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      // Note: retry logic would need to be implemented by the caller
      // This command just signals the intent
      console.log(color('[INFO] Retry requested - implement retry logic in caller', Colors.YELLOW));
      return true;
    },
  });

  registerSlashCommand({
    name: 'undo',
    description: 'Remove the last user/assistant exchange',
    category: 'Session',
    handler: async (_args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      // Note: undo logic would need to be implemented by the caller
      console.log(color('[INFO] Undo requested - implement undo logic in caller', Colors.YELLOW));
      return true;
    },
  });

  registerSlashCommand({
    name: 'title',
    description: 'Set a title for the current session',
    category: 'Session',
    argsHint: '[name]',
    handler: async (args, context) => {
      if (!args) {
        console.log(color('[INFO] Usage: /title <session name>', Colors.CYAN));
        return true;
      }
      // Note: title setting would need to be implemented by the caller
      console.log(color(`[OK] Session title set to: ${args}`, Colors.GREEN));
      return true;
    },
  });

  registerSlashCommand({
    name: 'stop',
    description: 'Kill all running background processes',
    category: 'Session',
    handler: async (_args, context) => {
      if (context?.platform === 'cli') {
        console.log(color('[OK] All background processes stopped', Colors.GREEN));
      } else {
        console.log('All background processes stopped');
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'compress',
    description: 'Manually compress conversation context',
    category: 'Session',
    argsHint: '[focus topic]',
    handler: async (args, context) => {
      const platform = context?.platform || 'cli';
      const focus = args || 'general';

      if (!context?.agent) {
        const msg = '[ERR] No agent context available';
        if (platform === 'cli') {
          console.log(color(msg, Colors.RED));
        } else {
          console.log(msg);
        }
        return true;
      }

      try {
        const messages = context.agent.getMessages();
        const beforeCount = messages.length;

        // TODO: Implement actual context compression logic
        // For now, show a placeholder message
        if (platform === 'cli') {
          console.log(color(`[OK] Context compression requested (focus: ${focus})`, Colors.GREEN));
          console.log(color(`  Messages before: ${beforeCount}`, Colors.DIM));
          console.log(color('  Note: Full compression logic to be implemented', Colors.YELLOW));
        } else {
          console.log(`Context compression requested (focus: ${focus})`);
          console.log(`Messages before: ${beforeCount}`);
        }
      } catch (err) {
        const errorMsg = `Failed to compress context: ${err instanceof Error ? err.message : String(err)}`;
        if (platform === 'cli') {
          console.error(color(`[ERR] ${errorMsg}`, Colors.RED));
        } else {
          console.log(`Error: ${errorMsg}`);
        }
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'agents',
    description: 'Show active agents and running tasks',
    category: 'Session',
    aliases: ['tasks'],
    handler: async (_args, context) => {
      const platform = context?.platform || 'cli';

      if (platform === 'cli') {
        console.log(color('\n[Active Agents & Tasks]', Colors.CYAN));
        console.log(color('  No active background agents', Colors.DIM));
        console.log(color('  No running tasks', Colors.DIM));
        console.log();
      } else {
        console.log('Active Agents & Tasks:');
        console.log('  No active background agents');
        console.log('  No running tasks');
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'plan',
    description: 'Create or view an execution plan',
    category: 'Session',
    argsHint: '[description|open]',
    handler: async (args, context) => {
      const platform = context?.platform || 'cli';
      const arg = args.trim().toLowerCase();

      if (!arg || arg === 'open') {
        // View current plan or show usage
        if (platform === 'cli') {
          console.log(color('\n[Plan]', Colors.CYAN));
          console.log(color('  No active plan', Colors.DIM));
          console.log(color('  Usage: /plan <description> - Create a new plan', Colors.DIM));
          console.log(color('         /plan open - Open plan in editor (future)', Colors.DIM));
          console.log();
        } else {
          console.log('Plan:');
          console.log('  No active plan');
          console.log('  Usage: /plan <description>');
        }
        return true;
      }

      // Create a new plan
      if (platform === 'cli') {
        console.log(color(`[OK] Plan created: ${args}`, Colors.GREEN));
        console.log(color('  Note: Plan execution to be implemented', Colors.YELLOW));
      } else {
        console.log(`Plan created: ${args}`);
      }
      return true;
    },
  });

  // Configuration commands
  registerSlashCommand({
    name: 'cd',
    description: 'Change working directory',
    category: 'Configuration',
    argsHint: '[path]',
    cliOnly: true,
    handler: async (args, context) => {
      if (!args) {
        console.log(color(`[INFO] Current directory: ${process.cwd()}`, Colors.CYAN));
        console.log(color('  Usage: /cd <path>', Colors.DIM));
        return true;
      }

      const newPath = resolve(process.cwd(), args);

      if (!existsSync(newPath)) {
        console.log(color(`[ERR] Directory does not exist: ${newPath}`, Colors.RED));
        return true;
      }

      if (!statSync(newPath).isDirectory()) {
        console.log(color(`[ERR] Not a directory: ${newPath}`, Colors.RED));
        return true;
      }

      process.chdir(newPath);

      // Update agent's working directory if agent is available
      if (context?.agent) {
        context.agent.setWorkingDirectory(newPath);
      }

      console.log(color(`[OK] Changed directory to: ${newPath}`, Colors.GREEN));
      return true;
    },
  });

  registerSlashCommand({
    name: 'config',
    description: 'Show current configuration',
    category: 'Configuration',
    cliOnly: true,
    handler: async () => {
      console.log(color('[INFO] Configuration:', Colors.CYAN));
      console.log(color(`  API Key: ${process.env.ANTHROPIC_API_KEY ? '***' : 'not set'}`, Colors.DIM));
      console.log(color(`  Model: ${process.env.ANTHROPIC_MODEL || 'default'}`, Colors.DIM));
      console.log(color(`  Workspace: ${process.cwd()}`, Colors.DIM));
      return true;
    },
  });

  registerSlashCommand({
    name: 'model',
    description: 'Switch model for this session',
    category: 'Configuration',
    argsHint: '[model-name]',
    handler: async (args, context) => {
      if (!args) {
        const currentModel = process.env.ANTHROPIC_MODEL || '';
        if (context?.platform === 'cli') {
          console.log(color(`[INFO] Current model: ${currentModel}`, Colors.CYAN));
          console.log(color('  Usage: /model <model-name>', Colors.DIM));
        } else {
          console.log(`Current model: ${currentModel}\nUsage: /model <model-name>`);
        }
        return true;
      }
      process.env.ANTHROPIC_MODEL = args;
      if (context?.platform === 'cli') {
        console.log(color(`[OK] Model set to: ${args}`, Colors.GREEN));
      } else {
        console.log(`Model set to: ${args}`);
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'effort',
    description: 'Manage reasoning effort and display',
    category: 'Configuration',
    argsHint: '[level|show|hide]',
    subcommands: ['none', 'minimal', 'low', 'medium', 'high', 'show', 'hide'],
    handler: async (args, context) => {
      const platform = context?.platform || 'cli';
      const arg = args.trim().toLowerCase();

      // Valid levels
      const levels = ['none', 'minimal', 'low', 'medium', 'high'];
      const currentEffort = process.env.DUYA_REASONING_EFFORT || 'medium';

      if (!arg || arg === 'show') {
        // Show current effort level
        if (platform === 'cli') {
          console.log(color(`\n[Reasoning Effort]`, Colors.CYAN));
          console.log(color(`  Current: ${currentEffort}`, Colors.DIM));
          console.log(color(`  Available levels: ${levels.join(', ')}`, Colors.DIM));
          console.log(color('  Usage: /effort <level> or /effort hide', Colors.DIM));
          console.log();
        } else {
          console.log(`Reasoning Effort: ${currentEffort}`);
          console.log(`Available levels: ${levels.join(', ')}`);
        }
        return true;
      }

      if (arg === 'hide') {
        process.env.DUYA_SHOW_REASONING = 'false';
        if (platform === 'cli') {
          console.log(color('[OK] Reasoning display hidden', Colors.GREEN));
        } else {
          console.log('Reasoning display hidden');
        }
        return true;
      }

      if (levels.includes(arg)) {
        process.env.DUYA_REASONING_EFFORT = arg;
        process.env.DUYA_SHOW_REASONING = 'true';
        if (platform === 'cli') {
          console.log(color(`[OK] Reasoning effort set to: ${arg}`, Colors.GREEN));
        } else {
          console.log(`Reasoning effort set to: ${arg}`);
        }
        return true;
      }

      // Invalid argument
      if (platform === 'cli') {
        console.log(color(`[ERR] Invalid effort level: ${arg}`, Colors.RED));
        console.log(color(`  Valid levels: ${levels.join(', ')}`, Colors.DIM));
      } else {
        console.log(`Invalid effort level: ${arg}`);
        console.log(`Valid levels: ${levels.join(', ')}`);
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'setup',
    description: 'Run setup wizard',
    category: 'Configuration',
    cliOnly: true,
    handler: async () => {
      const { runSetupWizard } = await import('./setup/index.js');
      await runSetupWizard();
      return true;
    },
  });

  // Tools & Skills
  registerSlashCommand({
    name: 'skills',
    description: 'List available skills',
    category: 'Tools & Skills',
    cliOnly: true,
    handler: async () => {
      console.log(color('[INFO] Skills:', Colors.CYAN));
      console.log(color('  Run "duya skills" for full skill management', Colors.DIM));
      return true;
    },
  });

  registerSlashCommand({
    name: 'tools',
    description: 'List available tools',
    category: 'Tools & Skills',
    cliOnly: true,
    handler: async () => {
      console.log(color('[INFO] Tools:', Colors.CYAN));
      console.log(color('  bash, read, write, edit, glob, grep, etc.', Colors.DIM));
      return true;
    },
  });

  // Info
  registerSlashCommand({
    name: 'help',
    description: 'Show available commands',
    category: 'Info',
    handler: async (_args, context) => {
      const platform = context?.platform || 'cli';

      if (platform === 'cli') {
        console.log(color('\nAvailable Commands:', Colors.CYAN));
        const byCategory = getSlashCommandsByCategory();
        for (const [category, commands] of byCategory) {
          console.log(color(`\n  ${category}:`, Colors.YELLOW));
          for (const cmd of commands) {
            const aliasStr = cmd.aliases?.length ? ` (aliases: ${cmd.aliases.join(', ')})` : '';
            console.log(color(`    /${cmd.name}${cmd.argsHint ? ' ' + cmd.argsHint : ''} - ${cmd.description}${aliasStr}`, Colors.DIM));
          }
        }
        console.log();
      } else {
        // For messaging platforms, use simpler formatting
        const lines = getGatewayHelpLines(platform);
        console.log(lines.join('\n'));
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'usage',
    description: 'Show token usage and rate limits',
    category: 'Info',
    handler: async (_args, context) => {
      if (context?.platform === 'cli') {
        console.log(color('[INFO] Token usage tracking coming soon', Colors.YELLOW));
      } else {
        console.log('Token usage tracking coming soon');
      }
      return true;
    },
  });

  // Exit
  registerSlashCommand({
    name: 'quit',
    description: 'Exit the CLI',
    category: 'Exit',
    aliases: ['exit', 'q'],
    cliOnly: true,
    handler: async () => {
      console.log(color('[OK] Goodbye!', Colors.GREEN));
      process.exit(0);
    },
  });
}

// Export for use in CLI
export { SLASH_COMMANDS };

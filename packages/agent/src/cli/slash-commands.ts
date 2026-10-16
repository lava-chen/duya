/**
 * Slash Commands System for DUYA CLI
 *
 * Inspired by hermes-agent's COMMAND_REGISTRY
 * Provides autocomplete and dispatch for /commands
 * Unified system for CLI, Telegram, and other platforms
 */

import { select } from '@inquirer/prompts';
import { Colors, color } from './colors.js';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import type { duyaAgent } from '../agent/DuyaAgent.js';
import { resolveProvider } from './config/file-config.js';
import { handleGoalCommand, isGoalControlCommand } from '../modes/goal/goal-commands.js';
import { handleTranscriptCommand } from '@duya/host/worker-session/transcript-commands';

export interface SlashCommandContext {
  agent?: duyaAgent;
  sessionId?: string;
  platform?: 'cli' | 'telegram' | 'duya-app' | 'web' | 'api';
  /** TUI-only bridge for provider registration and Desktop provider management. */
  providerLogin?: (action: 'add' | 'manage') => Promise<void>;
  /** TUI-only session switcher; the CLI owns Host session orchestration. */
  resumeSession?: (query: string) => Promise<void>;
  /** Persist a model change into the active Host session. */
  updateSessionModel?: (model: string) => Promise<void>;
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
  { name: 'resume', aliases: ['sessions'], description: 'Search and resume a previous session', category: 'Session', argsHint: '[query]', cliOnly: true },
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
  { name: 'goal', description: 'Goal mode: start an objective / status / pause / resume / clear / help', category: 'Session', argsHint: '[<objective>|status|pause|resume|clear|help]', subcommands: ['status', 'pause', 'resume', 'clear', 'help'] },

  // Configuration commands
  { name: 'config', description: 'Show current configuration', category: 'Configuration', cliOnly: true },
  { name: 'model', description: 'Switch model for this session', category: 'Configuration', argsHint: '[model-name]' },
  { name: 'login', description: 'Connect or manage a provider', category: 'Configuration', argsHint: '[add|manage]', subcommands: ['add', 'manage'] },
  { name: 'cd', description: 'Change working directory', category: 'Configuration', argsHint: '[path]', cliOnly: true },
  { name: 'setup', description: 'Run setup wizard', category: 'Configuration', cliOnly: true },
  { name: 'effort', description: 'Manage reasoning effort and display', category: 'Configuration', argsHint: '[level|show|hide]', subcommands: ['none', 'minimal', 'low', 'medium', 'high', 'show', 'hide'] },

  // Tools & Skills
  { name: 'skills', description: 'List available skills', category: 'Tools & Skills', cliOnly: true },
  { name: 'tools', description: 'List available tools', category: 'Tools & Skills', cliOnly: true },

  // Info
  { name: 'help', description: 'Show available commands', category: 'Info' },
  { name: 'usage', description: 'Show token usage and rate limits', category: 'Info' },
  { name: 'export', description: 'Export the session transcript to a Markdown file', category: 'Transcript', argsHint: '[path.md]' },
  { name: 'copy', description: 'Copy the last assistant reply to the clipboard', category: 'Transcript' },
  { name: 'transcript', description: 'Show transcript stats and export hints', category: 'Transcript' },

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

/** Index of the newest user message, or -1 when the session has none. */
function lastUserMessageIndex(messages: readonly { role: string }[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** One-line preview of a message body, for transcript echo. */
function messagePreview(message: { content: unknown }, limit = 160): string {
  const raw = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content);
  const flat = (raw ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/** Print one CLI-formatted line. */
function say(text: string, tone: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
  const tint = {
    info: Colors.CYAN,
    ok: Colors.GREEN,
    warn: Colors.YELLOW,
    error: Colors.RED,
  }[tone];
  console.log(color(text, tint));
}

// Initialize default slash commands
export function initSlashCommands(): void {
  // Goal mode (plan 552): deterministic control verbs; `/goal <objective>`
  // returns false so it falls through to the model (which starts the goal
  // and begins working in the same turn).
  registerSlashCommand({
    name: 'goal',
    description: 'Goal mode: start an objective / status / pause / resume / clear / help',
    category: 'Session',
    argsHint: '[<objective>|status|pause|resume|clear|help]',
    subcommands: ['status', 'pause', 'resume', 'clear', 'help'],
    handler: async (args, context) => {
      const input = args.trim() ? `/goal ${args.trim()}` : '/goal';
      if (!isGoalControlCommand(input)) {
        return false; // an objective — let the model start it
      }
      const result = await handleGoalCommand(input, {
        sessionId: context?.sessionId,
      });
      const platform = context?.platform ?? 'cli';
      if (platform === 'cli') {
        for (const line of result.reply.split('\n')) {
          console.log(color(line, Colors.CYAN));
        }
      } else {
        console.log(result.reply);
      }
      return true;
    },
  });

  // Transcript commands (plan 554 — minimax /export /copy /transcript parity)
  registerSlashCommand({
    name: 'export',
    description: 'Export the session transcript to a Markdown file',
    category: 'Transcript',
    argsHint: '[path.md]',
    handler: async (args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      const result = handleTranscriptCommand(`/export ${args}`.trim(), {
        messages: context.agent.getMessages(),
        sessionId: context.sessionId,
      });
      console.log(color(result.reply, result.reply.startsWith('Transcript exported') ? Colors.GREEN : Colors.YELLOW));
      return true;
    },
  });

  registerSlashCommand({
    name: 'copy',
    description: 'Copy the last assistant reply to the clipboard',
    category: 'Transcript',
    handler: async (_args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      const { getLastReplyText } = await import('@duya/agent-core/message');
      const text = getLastReplyText(context.agent.getMessages());
      if (!text) {
        console.log(color('[INFO] No assistant reply to copy yet', Colors.YELLOW));
        return true;
      }
      const platform = process.platform;
      try {
        const { execFileSync } = await import('child_process');
        if (platform === 'win32') {
          execFileSync('clip', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        } else if (platform === 'darwin') {
          execFileSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        } else {
          execFileSync('wl-copy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
        }
        console.log(color('[OK] Last reply copied to the clipboard', Colors.GREEN));
      } catch {
        // No clipboard helper available — print instead of failing silently.
        console.log(color('[INFO] Clipboard unavailable — last reply:', Colors.YELLOW));
        console.log(text);
      }
      return true;
    },
  });

  registerSlashCommand({
    name: 'transcript',
    description: 'Show transcript stats and export hints',
    category: 'Transcript',
    handler: async (_args, context) => {
      if (!context?.agent) {
        console.log(color('[ERR] No agent context available', Colors.RED));
        return true;
      }
      const messages = context.agent.getMessages();
      const byRole = messages.reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {});
      console.log(color(`Transcript: ${messages.length} message(s)`, Colors.CYAN));
      for (const [role, count] of Object.entries(byRole)) {
        console.log(color(`  ${role}: ${count}`, Colors.DIM));
      }
      console.log(color('Use /export [path.md] to write the full transcript to a Markdown file.', Colors.DIM));
      return true;
    },
  });

  // Session commands
  registerSlashCommand({
    name: 'resume',
    aliases: ['sessions'],
    description: 'Search and resume a previous session',
    category: 'Session',
    argsHint: '[query]',
    cliOnly: true,
    handler: async (args, context) => {
      if (context?.resumeSession === undefined) {
        console.log(color('Session resume is available in the interactive chat TUI.', Colors.YELLOW));
        return true;
      }
      await context.resumeSession(args.trim());
      return true;
    },
  });

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
      const resolution = resolveProvider(process.env.ANTHROPIC_MODEL);
      const model = resolution.ok
        ? resolution.provider.model.model
        : '';

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
      const agent = context?.agent;
      if (!agent) {
        say('[ERR] No agent context available', 'error');
        return true;
      }
      const messages = agent.getMessages();
      const userIndex = lastUserMessageIndex(messages);
      if (userIndex < 0) {
        say('[INFO] Nothing to retry - this session has no user message yet', 'warn');
        return true;
      }
      const prompt = messages[userIndex];
      const dropped = messages.length - 1 - userIndex;
      if (dropped > 0) {
        // Real state change: the assistant/tool tail of that turn is gone,
        // so the model re-answers the prompt instead of building on it.
        agent.setMessages(messages.slice(0, userIndex + 1));
      }
      say(`[OK] Dropped ${dropped} message(s) after the last prompt`, 'ok');
      say(`  Prompt: ${messagePreview(prompt)}`, 'info');
      say('  Send it again to re-run the turn.', 'info');
      // TODO: SlashCommandContext has no send primitive - the run is owned by
      // the caller (packages/agent/src/cli/index.ts uses the HeadlessRunHost,
      // packages/agent/src/cli/tui-session.ts uses runTurn). Adding
      // `sendPrompt?(prompt: string): Promise<void>` to SlashCommandContext and
      // wiring both callers would let /retry dispatch the turn itself instead
      // of only re-arming the prompt.
      return true;
    },
  });

  registerSlashCommand({
    name: 'undo',
    description: 'Remove the last user/assistant exchange',
    category: 'Session',
    handler: async (_args, context) => {
      const agent = context?.agent;
      if (!agent) {
        say('[ERR] No agent context available', 'error');
        return true;
      }
      const messages = agent.getMessages();
      const userIndex = lastUserMessageIndex(messages);
      if (userIndex < 0) {
        say('[INFO] Nothing to undo - this session has no user message yet', 'warn');
        return true;
      }
      const removed = messages.length - userIndex;
      agent.setMessages(messages.slice(0, userIndex));
      say(`[OK] Undid the last exchange (${removed} message(s) removed)`, 'ok');
      say(`  ${userIndex} message(s) remain`, 'info');
      return true;
    },
  });

  registerSlashCommand({
    name: 'title',
    description: 'Set a title for the current session',
    category: 'Session',
    argsHint: '[name]',
    handler: async (args, context) => {
      const sessionId = context?.sessionId;
      if (!sessionId) {
        say('[ERR] No session id in the command context', 'error');
        return true;
      }
      const { getSession, updateSession } = await import('../session/db.js');
      const title = args.trim();
      if (!title) {
        const current = getSession(sessionId);
        say(`[INFO] Current title: ${current?.title || '(untitled)'}`, 'info');
        say('  Usage: /title <name>', 'info');
        return true;
      }
      const updated = updateSession(sessionId, { title });
      if (updated === null) {
        say('[WARN] Standalone CLI mode does not persist session metadata.', 'warn');
        say('  Run duya through a Host (duya tui / duya serve) to persist it.', 'warn');
        return true;
      }
      say(`[OK] Session title set to: ${updated.title ?? title}`, 'ok');
      return true;
    },
  });

  registerSlashCommand({
    name: 'stop',
    description: 'Kill all running background processes',
    category: 'Session',
    handler: async (_args, context) => {
      const agent = context?.agent;
      if (!agent) {
        say('[ERR] No agent context available', 'error');
        return true;
      }
      const { backgroundAgentLifecycle } = await import(
        '@duya/host/worker-subagents/background-lifecycle',
      );
      const live = backgroundAgentLifecycle
        .getAll()
        .filter((task) => task.status === 'pending' || task.status === 'running');
      let killed = 0;
      for (const task of live) {
        if (backgroundAgentLifecycle.tryKill(task.taskId, 'user_kill') !== 'not_found') {
          killed += 1;
        }
      }
      // Abort the live turn last: a tool batch may be mid-flight, and killing
      // its sub-agents first is what makes the abort unwind cleanly.
      agent.interrupt();
      say(`[OK] Stopped the live turn and ${killed} background task(s)`, 'ok');
      return true;
    },
  });

  registerSlashCommand({
    name: 'compress',
    description: 'Manually compress conversation context',
    category: 'Session',
    argsHint: '[focus topic]',
    handler: async (args, context) => {
      const agent = context?.agent;
      if (!agent) {
        say('[ERR] No agent context available', 'error');
        return true;
      }
      const before = agent.getMessages().length;
      if (before === 0) {
        say('[INFO] Nothing to compress - the conversation is empty', 'warn');
        return true;
      }
      const focus = args.trim();
      try {
        const result = await agent.compact(
          focus === ''
            ? { trigger: 'manual' }
            : { trigger: 'manual', customInstructions: focus },
        );
        if (result.strategy === 'none') {
          say('[INFO] Nothing was compacted - the transcript is already short', 'warn');
          return true;
        }
        say(`[OK] Compacted with strategy '${result.strategy}'`, 'ok');
        if (focus !== '') say(`  Focus: ${focus}`, 'info');
        say(`  Messages: ${before} -> ${agent.getMessages().length} (${result.removedCount} summarised)`, 'info');
        say(`  Tokens removed: ${result.tokensRemoved} (${result.tokensRetained} retained)`, 'info');
      } catch (error) {
        say(`[ERR] Compaction failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
      const { getAgentDefinitions } = await import(
        '@duya/host/worker-subagents/built-in-agents',
      );
      const { backgroundAgentLifecycle } = await import(
        '@duya/host/worker-subagents/background-lifecycle',
      );

      const definitions = getAgentDefinitions();
      say(`\n[Sub-Agents] (${definitions.length} available)`, 'info');
      for (const definition of definitions) {
        say(`  ${definition.agentType.padEnd(16)} ${messagePreview({ content: definition.whenToUse }, 88)}`, 'info');
      }

      const tasks = backgroundAgentLifecycle.getAll();
      if (tasks.length === 0) {
        say('\n[Running Tasks] none', 'info');
        return true;
      }
      say(`\n[Running Tasks] (${tasks.length})`, 'info');
      for (const task of tasks) {
        const age = Math.max(0, Math.round((Date.now() - task.startedAt) / 1000));
        say(`  ${task.status.padEnd(9)} ${task.agentType} #${task.taskId.slice(0, 8)} (${age}s) ${task.description}`, 'info');
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
      const { modeModifierRegistry } = await import(
        '@duya/host/worker-modes/modifiers/registry',
      );
      const planning = modeModifierRegistry
        .list()
        .filter((mode) => mode.id.includes('plan'))
        .map((mode) => `${mode.id} (${mode.kind}-scoped)`);

      if (planning.length === 0) {
        say('[WARN] No planning mode is registered in this build.', 'warn');
        return true;
      }
      say('\n[Plan]', 'info');
      for (const mode of planning) say(`  Mode: ${mode}`, 'info');

      // duya has no stored plan artefact to read back: planning is a mode
      // overlay plus a plan the agent writes into the transcript, so /plan
      // reports the modes it can reach and hands the request to the agent
      // rather than pretending to persist a document.
      const description = args.trim();
      if (description !== '' && description !== 'open') {
        say(`\n  Send this to the agent: Plan ${description}`, 'info');
      } else {
        say('  Usage: /plan <description> - the agent drafts the plan in the transcript', 'info');
        say('  Enable the plan mode from the Desktop composer (@ > Plan Mode) to gate edits.', 'info');
      }
      // TODO: SlashCommandContext cannot switch a session mode - WorkerSession
      // exposes the mode registry but no setter, and the TUI/REPL own mode
      // state. A `setMode?(id: string)` bridge on SlashCommandContext would let
      // /plan activate `plan-task` and forward the description in one step.
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
      if (context?.agent) context.agent.model = args;
      await context?.updateSessionModel?.(args);
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
    name: 'login',
    description: 'Connect or manage a provider in Desktop settings',
    category: 'Configuration',
    argsHint: '[add|manage]',
    subcommands: ['add', 'manage'],
    handler: async (args, context) => {
      const action = args.trim().toLowerCase();
      if (action !== 'add' && action !== 'manage') {
        console.log(color('Choose /login add or /login manage.', Colors.CYAN));
        return true;
      }
      if (context?.providerLogin === undefined) {
        console.log(color('Provider setup is available in the interactive chat TUI.', Colors.YELLOW));
        return true;
      }
      await context.providerLogin(action);
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

  // Media generation (plan image-gen): /image <prompt> generates an image
  // directly through the [image_generation] provider config.
  registerSlashCommand({
    name: 'image',
    description: 'Generate an image: /image <prompt> [--model <m>] [--size <WxH>]',
    category: 'Tools & Skills',
    cliOnly: true,
    argsHint: '<prompt> [--model <model>] [--size <WxH>]',
    handler: async (args) => {
      const { runImageCommand } = await import('./imageCmds.js');
      const text = (args ?? '').trim();
      if (!text) {
        console.log(color('[ERR] Usage: /image <prompt> [--model <model>] [--size <WxH>]', Colors.RED));
        return true;
      }
      const code = await runImageCommand(text, {});
      return code === 0;
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
      const agent = context?.agent;
      if (!agent) {
        say('[ERR] No agent context available', 'error');
        return true;
      }
      const { seedTokenUsageFromHistory } = await import(
        '@duya/agent-core/usage/seed-token-usage',
      );
      const messages = agent.getMessages();
      const totals = seedTokenUsageFromHistory(messages);
      const grand = totals.totalInput + totals.totalOutput;
      say('\n[Token Usage]', 'info');
      if (grand === 0) {
        say('  No usage recorded yet - run a turn first.', 'warn');
        return true;
      }
      say(`  Input:       ${totals.totalInput}`, 'info');
      say(`  Output:      ${totals.totalOutput}`, 'info');
      say(`  Cache hit:   ${totals.totalCacheHit}`, 'info');
      say(`  Cache write: ${totals.totalCacheCreation}`, 'info');
      say(`  Total:       ${grand}`, 'info');
      say(`  Messages:    ${messages.length}`, 'info');
      say(`  Model:       ${agent.model || process.env.ANTHROPIC_MODEL || 'default'}`, 'info');
      // TODO: rate limits (per-provider quota headers) are not exposed to the
      // session runtime, so this reports consumption only.
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

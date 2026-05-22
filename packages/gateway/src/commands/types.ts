/**
 * Command System Types for Gateway
 *
 * Subset of App command types for gateway usage.
 */

export type CommandPlatform = 'app' | 'gateway';

export type CommandCategory =
  | 'session'
  | 'config'
  | 'info'
  | 'tools'
  | 'exit'
  | 'pairing';

export interface CommandDef {
  name: string;
  aliases?: readonly string[];
  description: string;
  category: CommandCategory;
  argsHint?: string;
  subcommands?: readonly string[];
  platforms?: readonly CommandPlatform[];
  requiresSession?: boolean;
  configGate?: string;
}

export interface CommandContext {
  sessionId?: string;
  args: string[];
  platform?: string;
  platformChatId?: string;
}

export type CommandResult =
  | { type: 'text'; content: string }
  | { type: 'error'; message: string }
  | { type: 'session_reset'; newSessionId?: string }
  | { type: 'dismiss' }
  | { type: 'forward'; prompt: string };

export interface HelpEntry {
  name: string;
  description: string;
  argsHint?: string;
  aliases?: readonly string[];
}

export interface HelpSection {
  category: CommandCategory;
  entries: HelpEntry[];
}
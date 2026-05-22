/**
 * Gateway Command Dispatcher
 *
 * Handles slash command dispatch for gateway platform messages.
 */

import type { NormalizedMessage, NormalizedReply } from '../types.js';
import { resolveCommand, isGatewayKnownCommand } from './registry.js';
import { generateHelpText } from './help.js';

export interface CommandDispatcherOptions {
  resetSession: (msg: NormalizedMessage) => Promise<{ oldSessionId: string; newSessionId: string }>;
  getSessionId: (msg: NormalizedMessage) => Promise<string | null>;
}

/**
 * Dispatch a command and return whether it was handled.
 */
export async function dispatchCommand(
  msg: NormalizedMessage,
  options: CommandDispatcherOptions
): Promise<boolean> {
  const text = msg.text ?? '';
  if (!text.startsWith('/')) return false;

  const parts = text.slice(1).split(/\s+/);
  const commandName = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);

  // Resolve command
  const cmd = resolveCommand(text);
  if (!cmd) {
    // Unknown command - let it pass through to agent
    return false;
  }

  // Handle built-in gateway commands
  switch (cmd.name) {
    case 'new':
    case 'reset': {
      const result = await options.resetSession(msg);
      return true;
    }

    case 'help': {
      // Help is handled by sending help text (caller should send reply)
      return true;
    }

    case 'status': {
      // Status is handled by caller (needs IPC)
      return true;
    }

    default:
      // For commands without local handlers, pass to agent
      return false;
  }
}

/**
 * Get the reply for a help command.
 */
export function getHelpReply(): NormalizedReply {
  return {
    type: 'text',
    text: generateHelpText('gateway'),
    parseMode: 'Markdown',
  };
}

/**
 * Get the reply for a status command.
 */
export function getStatusReply(msg: NormalizedMessage, sessionId: string | null): NormalizedReply {
  return {
    type: 'text',
    text: [
      '*Session Status*',
      '',
      `Platform: ${msg.platform}`,
      `Chat ID: \`${msg.platformChatId}\``,
      `Session: \`${sessionId ?? '(no active session)'}\``,
    ].join('\n'),
    parseMode: 'Markdown',
  };
}

/**
 * Get the reply for a new/reset session command.
 */
export function getNewSessionReply(newSessionId: string): NormalizedReply {
  return {
    type: 'text',
    text: `✨ Session reset! Starting fresh.\n\nNew session: \`${newSessionId}\``,
    parseMode: 'Markdown',
  };
}

/**
 * Check if a message looks like a command that should be intercepted.
 */
export function shouldInterceptCommand(text: string): boolean {
  if (!text.startsWith('/')) return false;
  const name = text.slice(1).toLowerCase().split(/\s+/)[0];
  return isGatewayKnownCommand(name);
}
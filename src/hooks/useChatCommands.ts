// useChatCommands.ts - Hook for local command execution

import { useCallback } from 'react';
import type { Message } from '@/types';

/**
 * Built-in command definitions
 */
export interface ChatCommand {
  name: string;
  description: string;
  execute: (context: CommandContext) => CommandResult;
}

export interface CommandContext {
  messages: Message[];
  clearMessages: () => void;
}

export interface CommandResult {
  content: string;
  isError?: boolean;
}

/**
 * Help command - shows available commands
 */
const helpCommand: ChatCommand = {
  name: '/help',
  description: 'Show available commands',
  execute: () => ({
    content: `Available commands:

**Built-in Commands:**
- /help - Show this help message
- /clear - Clear conversation history
- /cost - Show token usage statistics
- /compact - Compress conversation context (sent to agent)

**Slash Commands:**
Type '/' in the input to see available slash commands.`,
  }),
};

/**
 * Clear command - clears messages
 */
const clearCommand: ChatCommand = {
  name: '/clear',
  description: 'Clear conversation history',
  execute: (context) => {
    context.clearMessages();
    return {
      content: 'Conversation cleared.',
    };
  },
};

/**
 * Cost command - shows token usage (placeholder - would need actual tracking)
 */
const costCommand: ChatCommand = {
  name: '/cost',
  description: 'Show token usage statistics',
  execute: (context) => {
    // Calculate approximate token usage from messages
    const messages = context.messages;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const msg of messages) {
      // Rough estimate: ~4 characters per token
      const contentTokens = Math.ceil(msg.content.length / 4);
      if (msg.role === 'user') {
        totalInputTokens += contentTokens;
      } else if (msg.role === 'assistant') {
        totalOutputTokens += contentTokens;
      }
    }

    return {
      content: `**Token Usage (estimated):**

- Input tokens: ~${totalInputTokens}
- Output tokens: ~${totalOutputTokens}
- Total tokens: ~${totalInputTokens + totalOutputTokens}

*Note: These are rough estimates based on character count. Actual usage may vary.*`,
    };
  },
};

/**
 * All available chat commands
 */
const CHAT_COMMANDS: ChatCommand[] = [helpCommand, clearCommand, costCommand];

export interface UseChatCommandsReturn {
  executeCommand: (command: string) => CommandResult | null;
  getCommands: () => ChatCommand[];
  isImmediateCommand: (command: string) => boolean;
}

export function useChatCommands(context: CommandContext): UseChatCommandsReturn {
  const executeCommand = useCallback(
    (command: string): CommandResult | null => {
      const cmd = CHAT_COMMANDS.find((c) => c.name === command);
      if (cmd) {
        return cmd.execute(context);
      }
      return null;
    },
    [context],
  );

  const getCommands = useCallback(() => CHAT_COMMANDS, []);

  const isImmediateCommand = useCallback(
    (command: string): boolean => {
      return CHAT_COMMANDS.some((c) => c.name === command && c.execute.length === 1);
    },
    [],
  );

  return {
    executeCommand,
    getCommands,
    isImmediateCommand,
  };
}

// useChatCommands.ts - Hook for local command execution

import { useCallback } from 'react';
import type { Message } from '@/types';
import { resolveCommand, getCommandsForPlatform, generateHelpText } from '@/lib/commands';

/**
 * Command context for execution
 */
export interface CommandContext {
  messages: Message[];
  clearMessages: () => void;
}

/**
 * Command execution result
 */
export interface CommandResult {
  content: string;
  isError?: boolean;
  isSessionReset?: boolean;
  isDismiss?: boolean;
}

/**
 * Execute a command by name
 */
export function executeCommand(command: string, context: CommandContext): CommandResult | null {
  const cmd = resolveCommand(command);
  if (!cmd) return null;

  switch (cmd.name) {
    case 'help':
      return { content: generateHelpText('app') };

    case 'clear':
      context.clearMessages();
      return { content: '', isDismiss: true };

    case 'cost': {
      const messages = context.messages;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const msg of messages) {
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

*Note: These are rough estimates based on character count.*`,
      };
    }

    default:
      return null;
  }
}

export interface UseChatCommandsReturn {
  executeCommand: (command: string) => CommandResult | null;
  isKnownCommand: (command: string) => boolean;
  getAvailableCommands: () => Array<{ name: string; description: string }>;
}

export function useChatCommands(context: CommandContext): UseChatCommandsReturn {
  const execute = useCallback(
    (command: string): CommandResult | null => executeCommand(command, context),
    [context],
  );

  const isKnown = useCallback((command: string): boolean => {
    return resolveCommand(command) !== null;
  }, []);

  const getAvailable = useCallback(() => {
    return getCommandsForPlatform('app')
      .filter((cmd) => cmd.category === 'info' || cmd.name === 'clear')
      .map((cmd) => ({ name: cmd.name, description: cmd.description }));
  }, []);

  return {
    executeCommand: execute,
    isKnownCommand: isKnown,
    getAvailableCommands: getAvailable,
  };
}

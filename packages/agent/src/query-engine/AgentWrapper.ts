/**
 * AgentWrapper - Wraps duyaAgent for QueryEngine
 *
 * Provides a simplified interface for agent execution
 * with session management and event callbacks.
 */

import type {
  AgentWrapperOptions,
  WrapperOptions,
  QueryEvent,
} from './types.js';
import type {
  Message,
  MessageContent,
  ToolUse,
  ToolResult,
  TokenUsage,
  SSEEvent,
} from '../types.js';
import { duyaAgent } from '../index.js';
import { SessionManager, type SessionStore } from '../session/index.js';

// ============================================================================
// AgentWrapper Class
// ============================================================================

/**
 * AgentWrapper - Simplified agent wrapper
 *
 * Provides:
 * - Stream query with callbacks
 * - Complete query with full response
 * - Session management
 * - Interrupt capability
 */
export class AgentWrapper {
  private agent: duyaAgent;
  private sessionManager: SessionManager;
  private workingDirectory: string;
  private currentSession: SessionStore | null = null;
  private abortController: AbortController | null = null;

  constructor(agent: duyaAgent, options?: AgentWrapperOptions);
  constructor(options: AgentWrapperOptions);
  constructor(optionsOrAgent: AgentWrapperOptions | duyaAgent, maybeOptions?: AgentWrapperOptions) {
    // Handle overloaded constructor
    if (optionsOrAgent instanceof duyaAgent) {
      this.agent = optionsOrAgent;
      this.sessionManager = maybeOptions?.sessionManager || new SessionManager();
      this.workingDirectory = maybeOptions?.workingDirectory !== undefined
        ? maybeOptions.workingDirectory
        : process.cwd();
    } else {
      this.agent = optionsOrAgent.agent;
      this.sessionManager = optionsOrAgent.sessionManager || new SessionManager();
      this.workingDirectory = optionsOrAgent.workingDirectory !== undefined
        ? optionsOrAgent.workingDirectory
        : process.cwd();
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Stream query with optional callbacks
   * Yields events as they occur
   */
  async *query(
    prompt: string,
    options?: WrapperOptions,
  ): AsyncGenerator<QueryEvent> {
    this.abortController = new AbortController();

    // Add user message
    await this.sessionManager.addMessage({
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    try {
      for await (const event of this.agent.streamChat(prompt)) {
        if (this.abortController.signal.aborted) {
          break;
        }

        // Call callbacks
        if (options?.onStream) {
          options.onStream(event);
        }
        if (event.type === 'tool_use' && options?.onToolUse) {
          options.onToolUse(event.data);
        }
        if (event.type === 'tool_result' && options?.onToolResult) {
          options.onToolResult(event.data);
        }

        // Yield formatted event
        if (event.type === 'tool_use') {
          yield { type: 'tool_use', tool: event.data };
        } else if (event.type === 'tool_result') {
          yield { type: 'tool_result', result: event.data };
        } else if (event.type === 'text') {
          yield { type: 'message', message: { role: 'assistant', content: event.data } };
        } else if (event.type === 'done') {
          yield { type: 'done', result: { messages: [...this.agent.getMessages()], tokenUsage: { input_tokens: 0, output_tokens: 0 }, sessionId: this.getSessionId() } };
        }
      }
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Get complete query response
   */
  async queryComplete(prompt: string): Promise<Message> {
    const messages: Message[] = [];

    for await (const event of this.query(prompt)) {
      if (event.type === 'message') {
        messages.push(event.message);
      }
    }

    // Return last assistant message
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
    return lastAssistant || { role: 'assistant', content: '' };
  }

  // ============================================================================
  // Control Methods
  // ============================================================================

  /**
   * Interrupt the current query
   */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.agent.interrupt();
  }

  /**
   * Get current session ID
   */
  getSessionId(): string {
    return this.currentSession?.id || '';
  }

  /**
   * Get token usage for current session
   */
  getTokenUsage(): TokenUsage {
    return { input_tokens: 0, output_tokens: 0 };
  }

  /**
   * Clear messages in current session
   */
  clearMessages(): void {
    this.agent.clearMessages();
  }

  /**
   * Get agent instance for advanced usage
   */
  getAgent(): duyaAgent {
    return this.agent;
  }
}

// ============================================================================
// Export
// ============================================================================

export default AgentWrapper;

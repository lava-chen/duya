/**
 * QueryEngine - Core query execution engine
 *
 * Provides headless, SDK, and interactive modes for agent execution.
 * Separates core logic from REPL/TUI for flexible consumption.
 */

import type {
  QueryEngineOptions,
  QueryEngineMode,
  QueryOptions,
  PrintOptions,
  SDKOptions,
  QueryResult,
  SDKResult,
  QueryEvent,
  SessionInfo,
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
import type { CompactionManager } from '../compact/index.js';
import type { HookSystem } from './types.js';

// ============================================================================
// QueryEngine Class
// ============================================================================

/**
 * QueryEngine - Provides multiple execution modes for the agent
 *
 * Supports:
 * - Interactive mode: streaming with permission handling
 * - Print mode: headless single query, output to stdout
 * - SDK mode: library usage with structured results
 * - Background mode: runs without user interaction
 */
export class QueryEngine {
  private agent: duyaAgent;
  private sessionManager: SessionManager;
  private compactionManager: CompactionManager | undefined;
  private hooks: HookSystem | undefined;
  private mode: QueryEngineMode;
  private workingDirectory: string;
  private currentSession: SessionStore | null = null;
  private abortController: AbortController | null = null;

  constructor(options: QueryEngineOptions) {
    // Initialize agent
    if (options.agent) {
      this.agent = options.agent;
    } else if (options.agentConfig) {
      this.agent = new duyaAgent({
        apiKey: options.agentConfig.apiKey,
        baseURL: options.agentConfig.baseURL,
        model: options.agentConfig.model,
        workingDirectory: options.agentConfig.workingDirectory,
        systemPrompt: options.agentConfig.systemPrompt,
        provider: options.agentConfig.provider,
        communicationPlatform: options.agentConfig.communicationPlatform,
      });
    } else {
      throw new Error('Either agent or agentConfig must be provided');
    }

    // Initialize session manager
    this.sessionManager = options.sessionManager || new SessionManager();

    // Set compaction manager
    this.compactionManager = options.compactionManager;

    // Set hooks
    this.hooks = options.hooks;

    // Set mode
    this.mode = options.mode;

    // Set working directory - preserve empty string (no project folder)
    this.workingDirectory = options.workingDirectory !== undefined && options.workingDirectory !== null
      ? options.workingDirectory
      : process.cwd();
  }

  // ============================================================================
  // Mode-specific query methods
  // ============================================================================

  /**
   * Interactive streaming query
   * Yields events as they occur, supports interruption
   */
  async *query(
    prompt: string,
    options?: QueryOptions,
  ): AsyncGenerator<QueryEvent> {
    this.abortController = new AbortController();

    // Create or resume session
    const sessionId = options?.sessionId || this.currentSession?.id;
    if (sessionId) {
      this.currentSession = await this.sessionManager.loadSession(sessionId);
    }

    // Add user message to session
    await this.sessionManager.addMessage({
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    });

    // Check for compaction
    let compacted = false;
    let tokensSaved = 0;
    if (this.agent.shouldCompact()) {
      const result = await this.agent.compact();
      compacted = result.tokensRemoved > 0;
      tokensSaved = result.tokensRemoved;
      if (compacted) {
        yield {
          type: 'compaction',
          result: {
            strategy: result.strategy,
            tokensRemoved: result.tokensRemoved,
            tokensRetained: result.tokensRetained,
          },
        };
      }
    }

    // Collect token usage
    let totalTokenUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

    try {
      // Stream from agent
      for await (const event of this.agent.streamChat(prompt, {
        systemPrompt: options?.systemPrompt,
        tools: options?.tools,
        maxTokens: options?.maxTokens,
        temperature: options?.temperature,
      })) {
        // Handle abort
        if (this.abortController.signal.aborted) {
          break;
        }

        // Forward SSE events
        yield { type: 'stream', event };

        // Track token usage from result events
        if (event.type === 'result') {
          totalTokenUsage = event.data;
          yield { type: 'token_usage', usage: event.data };
        }

        // Forward tool events
        if (event.type === 'tool_use') {
          yield { type: 'tool_use', tool: event.data };
        }
        if (event.type === 'tool_result') {
          yield { type: 'tool_result', result: event.data };
        }

        // Call onEvent callback if provided
        if (options?.onEvent) {
          options.onEvent({
            type: 'stream',
            event,
          });
        }
      }

      // Add assistant response to session
      const messages = this.agent.getMessages();
      for (const msg of messages.slice(-2)) {
        await this.sessionManager.addMessage(msg);
      }

    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }

    // Return final result
    yield {
      type: 'done',
      result: {
        messages: [...this.agent.getMessages()],
        tokenUsage: totalTokenUsage,
        sessionId: this.sessionManager.getCurrentSession()?.id || '',
        compacted,
        tokensSaved,
      },
    };
  }

  /**
   * Synchronous query - waits for completion
   * Suitable for print and SDK modes
   */
  async querySync(
    prompt: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const events: QueryEvent[] = [];

    for await (const event of this.query(prompt, options)) {
      events.push(event);

      if (event.type === 'done') {
        return event.result;
      }
    }

    // If we get here without 'done', return what we have
    const lastEvent = events[events.length - 1];
    if (lastEvent?.type === 'done') {
      return lastEvent.result;
    }

    return {
      messages: [...this.agent.getMessages()],
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      sessionId: this.sessionManager.getCurrentSession()?.id || '',
    };
  }

  /**
   * Print mode - headless single query with formatted output
   * Outputs result to stdout and exits
   */
  async print(prompt: string, options?: PrintOptions): Promise<void> {
    const result = await this.querySync(prompt, {
      systemPrompt: options?.systemPrompt,
      tools: options?.tools,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    });

    // Format output based on options
    const format = options?.format || 'text';

    if (result.error) {
      console.error('Error:', result.error.message);
      return;
    }

    switch (format) {
      case 'json':
        console.log(JSON.stringify({
          content: this.extractTextContent(result.messages),
          toolCalls: result.messages
            .filter(m => m.role === 'assistant')
            .flatMap(m => Array.isArray(m.content) ? m.content : [])
            .filter(c => c.type === 'tool_use'),
          tokenUsage: result.tokenUsage,
        }, null, 2));
        break;

      case 'markdown':
        console.log(this.formatMarkdown(result.messages));
        break;

      case 'text':
      default:
        console.log(this.extractTextContent(result.messages));
        break;
    }
  }

  /**
   * SDK mode - library usage with structured output
   * Returns complete result with all details
   */
  async querySDK(prompt: string, options?: SDKOptions): Promise<SDKResult> {
    const toolCalls: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    let finalContent: MessageContent[] = [];

    for await (const event of this.query(prompt, {
      systemPrompt: options?.systemPrompt,
      tools: options?.tools,
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
    })) {
      if (event.type === 'tool_use') {
        toolCalls.push(event.tool);
      }
      if (event.type === 'tool_result') {
        toolResults.push(event.result);
      }
      if (event.type === 'done') {
        finalContent = this.extractMessageContent(event.result.messages);
      }
    }

    return {
      content: finalContent,
      toolCalls,
      toolResults,
      tokenUsage: { input_tokens: 0, output_tokens: 0 },
      sessionId: this.sessionManager.getCurrentSession()?.id || '',
    };
  }

  // ============================================================================
  // Session Management
  // ============================================================================

  /**
   * Create a new session
   */
  async createSession(metadata?: Record<string, unknown>): Promise<string> {
    const sessionInfo = await this.sessionManager.createSession(metadata);
    // Load full session with messages
    this.currentSession = await this.sessionManager.loadSession(sessionInfo.id);
    return sessionInfo.id;
  }

  /**
   * Resume an existing session
   */
  async resumeSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.currentSession = session;
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<SessionInfo[]> {
    return this.sessionManager.listSessions();
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.sessionManager.deleteSession(sessionId);
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.currentSession?.id || null;
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
   * Get token usage for current session
   */
  getTokenUsage(): TokenUsage {
    const messages = this.agent.getMessages();
    // Estimate from messages - actual implementation would track this
    return { input_tokens: 0, output_tokens: 0 };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private extractTextContent(messages: Message[]): string {
    const texts: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const content = msg.content;
        if (typeof content === 'string') {
          texts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              texts.push(block.text);
            }
          }
        }
      }
    }

    return texts.join('\n');
  }

  private extractMessageContent(messages: Message[]): MessageContent[] {
    const contents: MessageContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const content = msg.content;
        if (typeof content === 'string') {
          contents.push({ type: 'text', text: content });
        } else if (Array.isArray(content)) {
          contents.push(...content);
        }
      }
    }

    return contents;
  }

  private formatMarkdown(messages: Message[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        lines.push(`## User\n\n${content}\n`);
      } else if (msg.role === 'assistant') {
        const content = msg.content;
        if (typeof content === 'string') {
          lines.push(`## Assistant\n\n${content}\n`);
        } else if (Array.isArray(content)) {
          lines.push('## Assistant\n');
          for (const block of content) {
            if (block.type === 'text') {
              lines.push(`\n${block.text}\n`);
            } else if (block.type === 'tool_use') {
              lines.push(`\n**[Tool: ${block.name}]**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\`\n`);
            } else if (block.type === 'tool_result') {
              lines.push(`\n*[Tool Result]*\n${block.content}\n`);
            }
          }
        }
      }
    }

    return lines.join('---\n');
  }
}

// ============================================================================
// Export
// ============================================================================

export default QueryEngine;

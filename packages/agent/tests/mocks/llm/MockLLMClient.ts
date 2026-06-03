import type { LLMClient } from '../../../src/llm/base.js';
import type { SSEEvent } from '../../../src/types.js';

/**
 * Mock LLM client for testing
 */
export class MockLLMClient implements LLMClient {
  private responses: SSEEvent[][] = [];
  private responseIndex = 0;
  private throwError = false;
  private errorMessage = 'Mock LLM error';

  constructor(options?: { throwError?: boolean; errorMessage?: string }) {
    if (options?.throwError) {
      this.throwError = true;
      if (options.errorMessage) {
        this.errorMessage = options.errorMessage;
      }
    }
  }

  /**
   * Queue mock responses to be returned sequentially
   */
  queueResponses(responses: SSEEvent[][]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }

  /**
   * Set a single mock response to be returned repeatedly
   */
  setMockResponse(events: SSEEvent[]): void {
    this.responses = [events];
    this.responseIndex = 0;
  }

  async *streamChat(
    prompt: string,
    _options?: {
      systemPrompt?: string;
      tools?: Array<{
        name: string;
        description: string;
        input_schema: Record<string, unknown>;
      }>;
      maxTokens?: number;
      temperature?: number;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    if (this.throwError) {
      throw new Error(this.errorMessage);
    }

    const response = this.responses[this.responseIndex] || [
      { type: 'text', data: `Mock response to: ${prompt.slice(0, 50)}...` },
      { type: 'done' },
    ];
    this.responseIndex++;

    for (const event of response) {
      yield event;
    }
  }
}

/**
 * Factory to create a pre-configured mock client
 */
export function createMockLLMClient(config?: {
  textResponses?: string[];
  toolResponses?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
  }>;
  error?: boolean;
  errorMessage?: string;
}): MockLLMClient {
  const client = new MockLLMClient({
    throwError: config?.error,
    errorMessage: config?.errorMessage,
  });

  const events: SSEEvent[][] = [];

  if (config?.textResponses) {
    for (const text of config.textResponses) {
      events.push([
        { type: 'text', data: text },
        { type: 'done' },
      ]);
    }
  }

  if (config?.toolResponses) {
    for (const tool of config.toolResponses) {
      const toolUseId = crypto.randomUUID();
      events.push([
        {
          type: 'tool_use',
          data: { id: toolUseId, name: tool.name, input: tool.input },
        },
        {
          type: 'tool_result',
          data: { id: toolUseId, name: tool.name, result: tool.result },
        },
        { type: 'done' },
      ]);
    }
  }

  if (events.length > 0) {
    client.queueResponses(events);
  }

  return client;
}

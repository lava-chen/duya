/**
 * Ollama Native API Client
 *
 * Uses Ollama's native /api/chat endpoint instead of OpenAI-compatible /v1 endpoint.
 * This provides better support for:
 * - Tool calling
 * - Streaming
 * - Thinking/reasoning content
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type { SSEEvent, Tool, Message, MessageContent, TextContent, ToolUseContent, ToolResultContent, ImageContent } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { logger } from '../utils/logger.js';

/**
 * Ollama API message format
 */
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  thinking?: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaStreamResponse {
  model: string;
  created_at: string;
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/**
 * Counter for generating unique tool call IDs within a stream.
 */
let toolCallIdCounter = 0;

/**
 * Generate a unique tool call ID.
 */
function generateToolCallId(): string {
  return `ollama-tool-${Date.now()}-${++toolCallIdCounter}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Parse message content that may be stored as a stringified JSON array in the DB.
 * Only returns the parsed value if it's an array; otherwise returns the original content.
 */
function parseMessageContent(content: string | MessageContent[]): string | MessageContent[] {
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON, return as-is
    }
  }
  return content;
}

/**
 * Convert duya Message[] to Ollama message format
 */
function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: String(msg.content) });
    } else if (msg.role === 'user') {
      // Handle tool_result content
      if (Array.isArray(msg.content)) {
        const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        // Tool results in Ollama are sent as user messages with tool role
        for (const block of toolResultBlocks) {
          const resultBlock = block as ToolResultContent;
          result.push({
            role: 'tool',
            content: typeof resultBlock.content === 'string'
              ? resultBlock.content
              : JSON.stringify(resultBlock.content),
          });
        }

        // Other content as regular user message
        if (otherBlocks.length > 0) {
          const textContent = otherBlocks
            .filter(b => b.type === 'text')
            .map(b => (b as TextContent).text)
            .join('');
          const images = otherBlocks
            .filter(b => b.type === 'image')
            .map(b => (b as ImageContent).source.data);

          if (textContent || images.length > 0) {
            const userMsg: OllamaMessage = { role: 'user', content: textContent || undefined };
            if (images.length > 0) {
              userMsg.images = images;
            }
            result.push(userMsg);
          }
        }
      } else {
        result.push({ role: 'user', content: String(msg.content) });
      }
    } else if (msg.role === 'assistant') {
      // For assistant messages: extract text content and tool_calls separately
      const parsedContent = parseMessageContent(msg.content);
      let textContent = '';
      const toolCalls: OllamaToolCall[] = [];

      if (typeof parsedContent === 'string') {
        textContent = parsedContent;
      } else if (Array.isArray(parsedContent)) {
        for (const block of parsedContent) {
          if (block.type === 'text') {
            textContent += (block as TextContent).text;
          } else if (block.type === 'tool_use') {
            const toolBlock = block as ToolUseContent;
            const args = typeof toolBlock.input === 'object' && toolBlock.input !== null
              ? toolBlock.input as Record<string, unknown>
              : {};
            toolCalls.push({
              function: {
                name: toolBlock.name,
                arguments: args,
              },
            });
          } else if (block.type === 'thinking') {
            // Include thinking content as part of text to preserve context
            // Some Ollama models return thinking separately, but for history
            // we need to preserve it so the model maintains context
            textContent += `<thinking>${(block as { thinking?: string }).thinking || ''}</thinking>`;
          }
        }
      }

      const assistantMsg: OllamaMessage = {
        role: 'assistant',
        content: textContent || undefined,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === 'tool') {
      // Tool result messages
      result.push({
        role: 'tool',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  return result;
}

export class OllamaClient implements LLMClient {
  private baseURL: string;
  private model: string;
  private apiKey: string;

  constructor(options: LLMClientOptions) {
    // Remove /v1 suffix if present, use base URL
    let url = options.baseURL || 'http://localhost:11434';
    if (url.endsWith('/v1')) {
      url = url.slice(0, -3);
    }
    this.baseURL = url.replace(/\/$/, '');
    this.model = options.model;
    this.apiKey = options.apiKey?.trim() ?? '';
  }

  async *streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Tool[];
      maxTokens?: number;
      temperature?: number;
      topP?: number;
      presencePenalty?: number;
      frequencyPenalty?: number;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    // Reset tool call ID counter for each new stream
    toolCallIdCounter = 0;

    logger.info(`[OllamaClient] streamChat started, model=${this.model}, baseURL=${this.baseURL}`, undefined, 'OllamaClient');

    // Convert messages to Ollama format
    const ollamaMessages = toOllamaMessages(messages);

    // Add system prompt if provided
    if (options?.systemPrompt) {
      ollamaMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    logger.info(`[OllamaClient] Converted ${messages.length} messages to ${ollamaMessages.length} Ollama messages`, undefined, 'OllamaClient');
    // Log message summary for debugging context issues
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const contentPreview = typeof msg.content === 'string'
        ? msg.content.slice(0, 50)
        : Array.isArray(msg.content)
          ? msg.content.map((c: { type: string }) => c.type).join(',')
          : String(msg.content).slice(0, 50);
      logger.info(`[OllamaClient] Message ${i}: role=${msg.role}, contentPreview=${contentPreview}`, undefined, 'OllamaClient');
    }

    // Convert tools to Ollama format
    const tools: OllamaTool[] | undefined = options?.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    logger.info(`[OllamaClient] Sending request with ${tools?.length ?? 0} tools`, undefined, 'OllamaClient');

    // Build request body
    // Only enable thinking for models known to support it
    // Models like qwq, deepseek-r1, etc. support thinking
    // Other models may fail or behave unexpectedly with think: true
    const modelSupportsThinking = /^(qwq|deepseek-r1|qwen3|llama3\.3|mistral-small)/i.test(this.model);
    const requestBody: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: true,
      ...(modelSupportsThinking ? { think: true } : {}),
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 4096,
      },
    };

    if (options?.topP !== undefined) {
      (requestBody.options as Record<string, unknown>).top_p = options.topP;
    }
    if (options?.presencePenalty !== undefined) {
      (requestBody.options as Record<string, unknown>).presence_penalty = options.presencePenalty;
    }
    if (options?.frequencyPenalty !== undefined) {
      (requestBody.options as Record<string, unknown>).frequency_penalty = options.frequencyPenalty;
    }

    if (tools && tools.length > 0) {
      requestBody.tools = tools;
    }

    logger.info(`[OllamaClient] Request body: ${JSON.stringify({ ...requestBody, messages: `[${ollamaMessages.length} messages]` })}`, undefined, 'OllamaClient');
    logger.info(`[OllamaClient] Messages detail: ${JSON.stringify(ollamaMessages, null, 2)}`, undefined, 'OllamaClient');

    // Make request to Ollama native API with timeout and retry logic for unsupported features
    let response: Response | undefined;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      try {
        logger.info(`[OllamaClient] Sending fetch request to ${this.baseURL}/api/chat (attempt ${retryCount + 1})`, undefined, 'OllamaClient');
        response = await fetch(`${this.baseURL}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
        logger.info(`[OllamaClient] Fetch response received: ${response.status}`, undefined, 'OllamaClient');
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw new Error('Ollama API request timed out after 30 seconds');
        }
        throw new Error(`Ollama API request failed: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      }
      clearTimeout(timeoutId);

      if (response.ok) {
        break; // Success, exit retry loop
      }

      const errorText = await response.text();
      let needsRetry = false;

      // Check if the error is about thinking not being supported
      if ((errorText.includes('does not support thinking') || errorText.includes('thinking') || errorText.includes('reasoning')) && requestBody.think === true) {
        logger.warn(`[OllamaClient] Model ${this.model} does not support thinking, will retry without think mode`, undefined, 'OllamaClient');
        requestBody.think = false;
        needsRetry = true;
      }

      // Check if the error is about tools not being supported
      if ((errorText.includes('does not support tools') || errorText.includes('tools') || errorText.includes('tool call')) && requestBody.tools) {
        logger.warn(`[OllamaClient] Model ${this.model} does not support tools, will retry without tools`, undefined, 'OllamaClient');
        delete requestBody.tools;
        needsRetry = true;
      }

      if (!needsRetry) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      retryCount++;
      if (retryCount >= maxRetries) {
        throw new Error(`Ollama API error after ${maxRetries} retries: ${response.status} ${response.statusText} - ${errorText}`);
      }

      logger.info(`[OllamaClient] Retrying request (attempt ${retryCount + 1}/${maxRetries})`, undefined, 'OllamaClient');
    }

    // If we exit the loop without a successful response, throw an error
    if (!response) {
      throw new Error('Ollama API request failed after all retries');
    }

    if (!response.body) {
      throw new Error('Ollama API returned empty response body');
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;
    let hasReceivedContent = false;
    let hasReceivedToolCalls = false;
    let streamDone = false;
    let thinkingBuffer = ''; // Accumulate thinking content
    let hasYieldedThinking = false; // Track if we've yielded thinking event

    const READ_TIMEOUT = 30000; // 30 seconds timeout for each read
    let lastReadTime = Date.now();

    try {
      while (!streamDone) {
        // Check if we've been waiting too long for data
        if (Date.now() - lastReadTime > READ_TIMEOUT) {
          throw new Error(`Ollama stream read timeout: no data received for ${READ_TIMEOUT}ms`);
        }

        const { done, value } = await reader.read();
        lastReadTime = Date.now();

        if (done) {
          logger.info('[OllamaClient] Reader done', undefined, 'OllamaClient');
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const event = JSON.parse(line) as OllamaStreamResponse;
            eventCount++;

            if (eventCount === 1) {
              logger.info(`[OllamaClient] Received first stream event`, undefined, 'OllamaClient');
            }

            // Check if stream is done
            if (event.done) {
              logger.info(`[OllamaClient] Stream completed, total events: ${eventCount}`, undefined, 'OllamaClient');
              streamDone = true;

              // Yield token usage if available
              if (event.eval_count || event.prompt_eval_count) {
                yield {
                  type: 'result',
                  data: {
                    input_tokens: event.prompt_eval_count ?? 0,
                    output_tokens: event.eval_count ?? 0,
                    total_tokens: (event.prompt_eval_count ?? 0) + (event.eval_count ?? 0),
                  },
                };
              }

              // Report stop reason if available
              if (event.done_reason) {
                logger.info(`[OllamaClient] Stream done reason: ${event.done_reason}`, undefined, 'OllamaClient');
              }
              break;
            }

            // Process message content
            if (event.message) {
              const msg = event.message;

              // Handle assistant message with thinking content
              // Ollama streams thinking content in chunks, accumulate it
              if (msg.role === 'assistant' && msg.thinking) {
                hasReceivedContent = true;
                thinkingBuffer += msg.thinking;
                logger.debug(`[OllamaClient] Thinking chunk: ${msg.thinking.slice(0, 50)}`, undefined, 'OllamaClient');
              }

              // Handle assistant message with content
              if (msg.role === 'assistant' && msg.content) {
                hasReceivedContent = true;
                // If we have accumulated thinking content, yield it first before text
                if (thinkingBuffer && !hasYieldedThinking) {
                  hasYieldedThinking = true;
                  logger.info(`[OllamaClient] Yielding thinking: ${thinkingBuffer.slice(0, 50)}...`, undefined, 'OllamaClient');
                  yield {
                    type: 'thinking',
                    data: thinkingBuffer,
                  };
                }
                logger.info(`[OllamaClient] Content: ${msg.content.slice(0, 50)}`, undefined, 'OllamaClient');
                yield {
                  type: 'text',
                  data: msg.content,
                };
              }

              // Handle tool calls
              if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const toolCall of msg.tool_calls) {
                  hasReceivedToolCalls = true;
                  logger.info(`[OllamaClient] Tool call: ${toolCall.function.name}`, undefined, 'OllamaClient');
                  yield {
                    type: 'tool_use',
                    data: {
                      id: generateToolCallId(),
                      name: toolCall.function.name,
                      input: toolCall.function.arguments,
                    },
                  };
                }
              }
            }
          } catch (parseError) {
            logger.warn(`[OllamaClient] Failed to parse stream line: ${line}`, undefined, 'OllamaClient');
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer) as OllamaStreamResponse;
          if (event.message?.thinking) {
            hasReceivedContent = true;
            yield {
              type: 'thinking',
              data: event.message.thinking,
            };
          }
          if (event.message?.content) {
            hasReceivedContent = true;
            yield {
              type: 'text',
              data: event.message.content,
            };
          }
          if (event.message?.tool_calls && event.message.tool_calls.length > 0) {
            for (const toolCall of event.message.tool_calls) {
              hasReceivedToolCalls = true;
              yield {
                type: 'tool_use',
                data: {
                  id: generateToolCallId(),
                  name: toolCall.function.name,
                  input: toolCall.function.arguments,
                },
              };
            }
          }
        } catch (parseErr) {
          // Ignore parse error for final buffer
          logger.warn(`[OllamaClient] Failed to parse final buffer: ${buffer.slice(0, 100)}`, undefined, 'OllamaClient');
        }
      }
    } catch (streamError) {
      logger.error(`[OllamaClient] Stream error`, streamError instanceof Error ? streamError : new Error(String(streamError)), undefined, 'OllamaClient');
      throw streamError;
    } finally {
      try {
        reader.releaseLock();
      } catch (releaseErr) {
        // Reader may already be released
        logger.debug(`[OllamaClient] Reader release: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`, undefined, 'OllamaClient');
      }
    }

    // If we have accumulated thinking content but never yielded it, yield it now
    if (thinkingBuffer && !hasYieldedThinking) {
      hasYieldedThinking = true;
      logger.info(`[OllamaClient] Yielding accumulated thinking at end: ${thinkingBuffer.slice(0, 50)}...`, undefined, 'OllamaClient');
      yield {
        type: 'thinking',
        data: thinkingBuffer,
      };
    }

    if (!hasReceivedContent && !hasReceivedToolCalls) {
      logger.warn('[OllamaClient] No content or tool calls received from stream', undefined, 'OllamaClient');
    }

    yield { type: 'done' };
  }
}

/**
 * OpenAI-compatible protocol LLM client
 * Supports OpenRouter, MiniMax OpenAI endpoint, and other OpenAI-compatible APIs
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SSEEvent, Tool, Message, MessageContent, TextContent, ToolUseContent, ToolResultContent } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { logger } from '../utils/logger.js';

/**
 * Parse message content that may be stored as a stringified JSON array in the DB.
 * When messages are stored to DB, array content is JSON-stringified.
 * When retrieved, it needs to be parsed back to the original format.
 */
function parseMessageContent(content: string | MessageContent[]): string | MessageContent[] {
  if (typeof content === 'string') {
    // Try to parse stringified JSON array
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
 * Convert duya Message[] to OpenAI ChatCompletionMessageParam[]
 * @param includeToolCalls - Whether to include tool_calls in assistant messages (default: true)
 */
function toOpenAIMessages(messages: Message[], includeToolCalls: boolean = true): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: String(msg.content) });
    } else if (msg.role === 'user') {
      // Check if this is a tool_result message (user role with tool_result content)
      if (Array.isArray(msg.content)) {
        const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        // Handle tool_result blocks as tool role messages (only if includeToolCalls is true)
        if (includeToolCalls) {
          for (const block of toolResultBlocks) {
            const resultBlock = block as ToolResultContent;
            result.push({
              role: 'tool',
              tool_call_id: resultBlock.tool_use_id,
              content: typeof resultBlock.content === 'string'
                ? resultBlock.content
                : JSON.stringify(resultBlock.content),
            });
          }
        }

        // Handle other content as regular user message
        if (otherBlocks.length > 0) {
          const content = convertContentToOpenAI(otherBlocks);
          if (typeof content === 'string') {
            result.push({ role: 'user', content });
          } else {
            result.push({ role: 'user', content });
          }
        }
      } else {
        // Simple string content
        result.push({ role: 'user', content: String(msg.content) });
      }
    } else if (msg.role === 'assistant') {
      // For assistant messages: extract text content and tool_calls separately
      // Parse content if it's a string representation of an array (from DB storage)
      const parsedContent = parseMessageContent(msg.content);
      const toolCalls = includeToolCalls ? extractToolCalls(parsedContent) : undefined;
      let textContent = '';
      if (typeof parsedContent === 'string') {
        textContent = parsedContent;
      } else if (Array.isArray(parsedContent)) {
        for (const block of parsedContent) {
          if (block.type === 'text') {
            textContent += (block as TextContent).text;
          }
        }
      }
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textContent || undefined,
      };
      if (toolCalls) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else if (msg.role === 'tool') {
      // Tool result messages - only include if includeToolCalls is true
      if (includeToolCalls) {
        result.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id || '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      }
    }
  }

  return result;
}

/**
 * Convert duya MessageContent to OpenAI content format
 */
function convertContentToOpenAI(content: string | MessageContent[]): string | Array<OpenAI.Chat.ChatCompletionContentPart> {
  if (typeof content === 'string') {
    return content;
  }

  const parts: Array<OpenAI.Chat.ChatCompletionContentPart> = [];

  for (const block of content) {
    if (block.type === 'text') {
      parts.push({
        type: 'text',
        text: (block as TextContent).text,
      });
    } else if (block.type === 'image') {
      // OpenAI supports image content blocks
      const imgBlock = block as { type: 'image'; source: { type: 'base64' | 'url'; media_type: string; data: string } };
      parts.push({
        type: 'image_url',
        image_url: {
          url: imgBlock.source.type === 'base64'
            ? `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`
            : imgBlock.source.data,
        },
      });
    }
    // tool_result blocks are handled separately in toOpenAIMessages
    // tool_use blocks are handled separately via tool_calls
  }

  return parts;
}

/**
 * Extract tool_use blocks from assistant message content for OpenAI tool_calls
 */
function extractToolCalls(content: string | MessageContent[]): OpenAI.Chat.ChatCompletionMessageToolCall[] | undefined {
  if (typeof content === 'string') return undefined;

  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

  for (const block of content) {
    if (block.type === 'tool_use') {
      const toolBlock = block as ToolUseContent;
      toolCalls.push({
        id: toolBlock.id,
        type: 'function',
        function: {
          name: toolBlock.name,
          arguments: JSON.stringify(toolBlock.input),
        },
      });
    }
  }

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private baseURL: string | undefined;
  private supportsTools: boolean | undefined;

  constructor(options: LLMClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      dangerouslyAllowBrowser: true,
    });
    this.model = options.model;
    this.baseURL = options.baseURL;
    this.supportsTools = undefined; // Will be determined on first call
  }

  async *streamChat(
    messages: Message[],
    options?: {
      systemPrompt?: string;
      tools?: Tool[];
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    // Determine if we should try tools based on whether tools are provided and supported
    const shouldTryTools = options?.tools && options.tools.length > 0 && this.supportsTools !== false;

    logger.info(`[OpenAIClient] streamChat started, model=${this.model}, shouldTryTools=${shouldTryTools}, supportsTools=${this.supportsTools}`, undefined, 'OpenAIClient');

    // Convert messages, including tool calls only if we're trying tools
    const openAIMessages = toOpenAIMessages(messages, shouldTryTools);

    logger.info(`[OpenAIClient] Converted ${messages.length} messages to ${openAIMessages.length} OpenAI messages`, undefined, 'OpenAIClient');

    // Add system prompt if provided (prepended to messages)
    if (options?.systemPrompt) {
      openAIMessages.unshift({ role: 'system', content: options.systemPrompt });
    }

    // If no messages, add an empty user message
    if (openAIMessages.length === 0) {
      openAIMessages.push({ role: 'user', content: '' });
    }

    // Convert tools to OpenAI format
    const tools = shouldTryTools
      ? options?.tools?.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        }))
      : undefined;

    logger.info(`[OpenAIClient] Sending request with ${tools?.length ?? 0} tools`, undefined, 'OpenAIClient');

    try {
      yield* this.doStreamChat(openAIMessages, {
        ...options,
        tools,
      });
    } catch (error) {
      // Check if error is due to tools not being supported
      const errorMessage = error instanceof Error ? error.message : String(error);
      const lowerErrorMessage = errorMessage.toLowerCase();
      const isToolsError = lowerErrorMessage.includes('does not support tools') ||
                          lowerErrorMessage.includes('tools are not supported') ||
                          lowerErrorMessage.includes('function calling is not supported') ||
                          lowerErrorMessage.includes('tool use is not supported') ||
                          lowerErrorMessage.includes('tools not supported');

      if (isToolsError && shouldTryTools) {
        // Mark this model as not supporting tools
        this.supportsTools = false;
        logger.info(`Model ${this.model} does not support tools, retrying without tools`, undefined, 'OpenAIClient');

        // Re-convert messages without tool calls for the retry
        const openAIMessagesWithoutTools = toOpenAIMessages(messages, false);

        // Add system prompt if provided (prepended to messages)
        if (options?.systemPrompt) {
          openAIMessagesWithoutTools.unshift({ role: 'system', content: options.systemPrompt });
        }

        // If no messages, add an empty user message
        if (openAIMessagesWithoutTools.length === 0) {
          openAIMessagesWithoutTools.push({ role: 'user', content: '' });
        }

        // Retry without tools
        yield* this.doStreamChat(openAIMessagesWithoutTools, {
          ...options,
          tools: undefined,
        });
      } else {
        // Re-throw other errors
        throw error;
      }
    }
  }

  private async *doStreamChat(
    openAIMessages: ChatCompletionMessageParam[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
      maxTokens?: number;
      temperature?: number;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    logger.info(`[OpenAIClient] doStreamChat starting, model=${this.model}, baseURL=${this.baseURL}`, undefined, 'OpenAIClient');

    const requestParams = {
      model: this.model,
      messages: openAIMessages,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 1,
      tools: options?.tools?.length ? options.tools : undefined,
      stream: true,
    };

    logger.info(`[OpenAIClient] Request params: ${JSON.stringify({ ...requestParams, messages: `[${requestParams.messages.length} messages]` })}`, undefined, 'OpenAIClient');

    const stream = await this.client.chat.completions.create(requestParams) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

    // Track multiple tool calls by index (OpenAI streams tool_calls with index)
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
    // For parsing MiniMax <think> tags embedded in text
    let thinkBuffer = '';
    let isInThinkTag = false;
    let hasExtractedThinkContent = false;
    const MAX_THINK_BUFFER_LENGTH = 10000; // Max buffer size before flushing
    const THINK_TAG_PATTERN = /<(think|thinking|thought)[^>]*>/i;
    const THINK_CLOSE_PATTERN = /<\/(think|thinking|thought)>/i;

    let eventCount = 0;
    for await (const event of stream) {
      eventCount++;
      const delta = event.choices[0]?.delta;
      const finishReason = event.choices[0]?.finish_reason;

      if (eventCount === 1) {
         logger.info(`[OpenAIClient] Received first stream event`, undefined, 'OpenAIClient');
       }

      if (!delta) continue;

      // Handle text content with MiniMax <think> tag parsing
      if (delta.content) {
        const textDelta = delta.content;
        thinkBuffer += textDelta;

        // Log first chunk to see the format
        if (eventCount <= 5 && thinkBuffer.length < 500) {
          logger.info(`[OpenAIClient] Content chunk ${eventCount}: ${JSON.stringify(textDelta)}`, undefined, 'OpenAIClient');
        }

        // Check if we're entering a think tag (support various formats)
        if (!isInThinkTag && THINK_TAG_PATTERN.test(thinkBuffer)) {
          isInThinkTag = true;
          logger.info(`[OpenAIClient] Entered think tag, buffer: ${JSON.stringify(thinkBuffer.slice(0, 100))}`, undefined, 'OpenAIClient');
        }

        // Check if think tag is complete
        if (isInThinkTag && THINK_CLOSE_PATTERN.test(thinkBuffer)) {
          // Extract think content using dynamic regex
          const openTagMatch = thinkBuffer.match(THINK_TAG_PATTERN);
          const closeTagMatch = thinkBuffer.match(THINK_CLOSE_PATTERN);

          if (openTagMatch && closeTagMatch && !hasExtractedThinkContent) {
            hasExtractedThinkContent = true;
            // Extract content between tags
            const openIndex = thinkBuffer.indexOf(openTagMatch[0]);
            const closeIndex = thinkBuffer.indexOf(closeTagMatch[0]);
            if (openIndex !== -1 && closeIndex !== -1 && closeIndex > openIndex) {
              const extractedThinking = thinkBuffer.slice(openIndex + openTagMatch[0].length, closeIndex).trim();
              logger.info(`[OpenAIClient] Extracted thinking content: ${extractedThinking.slice(0, 100)}...`, undefined, 'OpenAIClient');
              if (extractedThinking) {
                yield {
                  type: 'thinking',
                  data: extractedThinking.slice(0, 200),
                };
              }
            }
          }

          // Yield only the content after closing tag as normal text
          const closeMatch = thinkBuffer.match(THINK_CLOSE_PATTERN);
          if (closeMatch) {
            const afterThink = thinkBuffer.slice(thinkBuffer.indexOf(closeMatch[0]) + closeMatch[0].length);
            if (afterThink) {
              yield {
                type: 'text',
                data: afterThink,
              };
            }
          }
          // Reset state for potential next think block
          thinkBuffer = '';
          isInThinkTag = false;
        } else if (!isInThinkTag) {
          // No think tag, yield as normal text immediately
          yield {
            type: 'text',
            data: textDelta,
          };
          // Clear buffer since we're yielding immediately
          thinkBuffer = '';
        } else if (isInThinkTag && thinkBuffer.length > MAX_THINK_BUFFER_LENGTH) {
          // Buffer is getting too large, flush it to avoid hanging
          // This handles cases where closing tag is never received
          logger.warn('[OpenAIClient] Think buffer exceeded max length, flushing content', undefined, 'OpenAIClient');
          yield {
            type: 'text',
            data: thinkBuffer,
          };
          thinkBuffer = '';
          isInThinkTag = false;
        }
        // If in think tag but not complete yet, continue buffering
      }

      // Handle tool calls - accumulate by index
      if (delta.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const idx = toolCall.index ?? 0;

          if (toolCall.function?.name) {
            // First chunk for this tool call: has id and function.name
            toolCallsMap.set(idx, {
              id: toolCall.id || crypto.randomUUID(),
              name: toolCall.function.name,
              arguments: '',
            });
          }

          // Accumulate arguments
          if (toolCall.function?.arguments) {
            const entry = toolCallsMap.get(idx);
            if (entry) {
              entry.arguments += toolCall.function.arguments;
            }
          }
        }
      }

      // When the stream signals completion via finish_reason, yield all tool calls
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        // Yield all accumulated tool calls
        if (toolCallsMap.size > 0) {
          for (const [_, entry] of toolCallsMap) {
            try {
              const input = JSON.parse(entry.arguments || '{}');
              yield {
                type: 'tool_use',
                data: {
                  id: entry.id,
                  name: entry.name,
                  input,
                },
              };
            } catch {
              // Invalid JSON, yield with empty input
              yield {
                type: 'tool_use',
                data: {
                  id: entry.id,
                  name: entry.name,
                  input: {},
                },
              };
            }
          }
          toolCallsMap.clear();
        }
      }
    }

    // Yield any remaining tool calls that weren't signaled by finish_reason
    if (toolCallsMap.size > 0) {
      for (const [_, entry] of toolCallsMap) {
        try {
          const input = JSON.parse(entry.arguments || '{}');
          yield {
            type: 'tool_use',
            data: {
              id: entry.id,
              name: entry.name,
              input,
            },
          };
        } catch {
          yield {
            type: 'tool_use',
            data: {
              id: entry.id,
              name: entry.name,
              input: {},
            },
          };
        }
      }
    }

    // If there's remaining content in think buffer, yield it
    if (thinkBuffer) {
      logger.info(`[OpenAIClient] Yielding remaining buffer at end: ${JSON.stringify(thinkBuffer.slice(0, 100))}`, undefined, 'OpenAIClient');
      if (isInThinkTag && !hasExtractedThinkContent) {
        // Extract thinking content from incomplete tag
        const openTagMatch = thinkBuffer.match(THINK_TAG_PATTERN);
        if (openTagMatch) {
          const openIndex = thinkBuffer.indexOf(openTagMatch[0]);
          const extractedThinking = thinkBuffer.slice(openIndex + openTagMatch[0].length).trim();
          logger.info(`[OpenAIClient] Extracted incomplete thinking: ${extractedThinking.slice(0, 100)}...`, undefined, 'OpenAIClient');
          if (extractedThinking) {
            yield {
              type: 'thinking',
              data: extractedThinking.slice(0, 200),
            };
          }
        } else {
          // No think tag found, yield as normal text
          yield {
            type: 'text',
            data: thinkBuffer,
          };
        }
      } else {
        // Yield remaining buffer as normal text
        yield {
          type: 'text',
          data: thinkBuffer,
        };
      }
    }

    logger.info(`[OpenAIClient] Stream completed, total events: ${eventCount}`, undefined, 'OpenAIClient');

    yield { type: 'done' };
  }
}

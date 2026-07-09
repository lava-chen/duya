/**
 * OpenAI-compatible protocol LLM client
 * Supports OpenRouter, MiniMax OpenAI endpoint, and other OpenAI-compatible APIs
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../types.js';
import type { SSEEvent, Tool, Message, MessageContent, TextContent, ToolUseContent, ToolResultContent, TokenUsage } from '../types.js';
import type { LLMClient, LLMClientOptions } from './base.js';
import { logger } from '../utils/logger.js';
import { extractToolInputPreview, hasToolInputPreview } from './tool-input-preview.js';

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

// Domains that represent CDN-hosted images which should be treated as inline images,
// not as web pages. MiniMax uploads user-attached images to these CDNs and returns
// CDN URLs in the conversation history.
const CDN_IMAGE_DOMAINS = [
  /https?:\/\/[^\s]*\.oss-cn-[a-z0-9-]+\.aliyuncs\.com[^\s]*/i,
  /https?:\/\/[^\s]*\.minimax\.io[^\s]*/i,
  /https?:\/\/[^\s]*\.minimaxi\.com[^\s]*/i,
  /https?:\/\/[^/]*\.alicdn\.com[^\s]*/i,
  /https?:\/\/[^/]*\.aliyuncs\.com[^\s]*/i,
];

function isCDNImageUrl(url: string): boolean {
  return CDN_IMAGE_DOMAINS.some(pattern => pattern.test(url));
}

function stripCDNUrlsFromText(text: string): string {
  for (const pattern of CDN_IMAGE_DOMAINS) {
    text = text.replace(pattern, '');
  }
  return text;
}

/**
 * Check if a buffer could be the start of a think/thinking/thought tag.
 * Used to avoid prematurely yielding text that might be a partial tag
 * split across stream chunks.
 *
 * Returns true when:
 * - The buffer starts with '<' AND
 * - The buffer is a prefix of a tag name (e.g. "<th" is a prefix of "<think"), OR
 * - The buffer starts with a full tag name but has no closing '>' yet (e.g. "<thinking foo")
 */
function couldBeThinkTagPrefix(buffer: string): boolean {
  if (!buffer.startsWith('<')) return false;
  const lower = buffer.toLowerCase();
  const tagNames = ['<think', '<thinking', '<thought'];
  for (const tag of tagNames) {
    // Buffer is a prefix of the tag name (e.g., "<th" is prefix of "<think")
    if (tag.startsWith(lower)) return true;
    // Buffer starts with the full tag name but no closing > yet
    if (lower.startsWith(tag) && !lower.includes('>')) return true;
  }
  return false;
}

/**
 * Scan OpenAI content parts for MiniMax CDN image URLs and strip them out.
 * The CDN URLs are MiniMax's internal representation of user-uploaded images.
 * Since we store base64 data in message_attachments and rehydrate at load time,
 * these CDN URLs should never reach the LLM — but this is a safety net.
 *
 * Content parts containing CDN URLs are removed so the model never sees them
 * and never tries to open them with a browser tool.
 */
function filterCDNImageUrls(parts: Array<OpenAI.Chat.ChatCompletionContentPart>): Array<OpenAI.Chat.ChatCompletionContentPart> {
  return parts.filter(part => {
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      if (isCDNImageUrl(part.image_url.url)) {
        logger.warn('[OpenAIClient] Filtered CDN image URL from content', { url: part.image_url.url.substring(0, 80) });
        return false;
      }
    }
    return true;
  });
}

function hasAssistantContent(message: OpenAI.Chat.ChatCompletionAssistantMessageParam): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.length > 0;
  }
  return content != null;
}

function dropPendingToolCalls(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  pendingToolCallIds: Set<string>,
): void {
  if (pendingToolCallIds.size === 0) {
    return;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      continue;
    }

    const assistantMessage = message as OpenAI.Chat.ChatCompletionAssistantMessageParam;
    const toolCalls = assistantMessage.tool_calls;
    if (!toolCalls?.length) {
      continue;
    }

    const keptToolCalls = toolCalls.filter((toolCall) => !pendingToolCallIds.has(toolCall.id));
    if (keptToolCalls.length > 0) {
      assistantMessage.tool_calls = keptToolCalls;
    } else {
      const droppedCount = toolCalls.length;
      delete assistantMessage.tool_calls;
      if (!hasAssistantContent(assistantMessage)) {
        messages.splice(i, 1);
      }
      logger.warn(
        `[OpenAIClient] Dropped ${droppedCount} pending tool call(s) without matching tool results`,
        { toolCallIds: toolCalls.map(tc => tc.id) },
        'OpenAIClient',
      );
    }
    pendingToolCallIds.clear();
    return;
  }

  pendingToolCallIds.clear();
}

function normalizeOpenAIToolMessages(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const normalized: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const pendingToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id;
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        normalized.push(message);
        pendingToolCallIds.delete(toolCallId);
      }
      continue;
    }

    dropPendingToolCalls(normalized, pendingToolCallIds);
    normalized.push(message);

    if (message.role === 'assistant') {
      const assistantMessage = message as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      for (const toolCall of assistantMessage.tool_calls ?? []) {
        pendingToolCallIds.add(toolCall.id);
      }
    }
  }

  dropPendingToolCalls(normalized, pendingToolCallIds);
  return normalized;
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
            // Safety net: filter CDN image URLs to prevent MiniMax CDN URLs
            // from reaching the model (they are artifacts of MiniMax's upstream
            // processing, not user-intended web resources)
            const filtered = filterCDNImageUrls(content);
            if (filtered.length > 0) {
              result.push({ role: 'user', content: filtered });
            }
          }
        }
      } else {
        // Simple string content
        result.push({ role: 'user', content: String(msg.content) });
      }
    } else if (msg.role === 'assistant') {
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
      textContent = stripCDNUrlsFromText(textContent);
      // Skip assistant messages that contain neither textual content nor tool calls.
      // These are typically thinking-only artifacts and can degrade context quality.
      if (!textContent.trim() && (!toolCalls || toolCalls.length === 0)) {
        continue;
      }
      const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textContent || null,
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

  return normalizeOpenAIToolMessages(result);
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
      if (imgBlock.source.type === 'base64') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}`,
          },
        });
      } else if (!isCDNImageUrl(imgBlock.source.data)) {
        parts.push({
          type: 'image_url',
          image_url: {
            url: imgBlock.source.data,
          },
        });
      }
      // Silently drop CDN URLs — they are MiniMax artifacts, not user-intended resources
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

  async chat(
    _messages: Message[],
    _options?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): Promise<{ content: string; usage?: TokenUsage }> {
    throw new Error('chat() is not supported for OpenAI client. Use streamChat() instead.');
  }

  private async *doStreamChat(
    openAIMessages: ChatCompletionMessageParam[],
    options?: {
      systemPrompt?: string;
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
      maxTokens?: number;
      temperature?: number;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<SSEEvent, void, unknown> {
    logger.info(`[OpenAIClient] doStreamChat starting, model=${this.model}, baseURL=${this.baseURL}`, undefined, 'OpenAIClient');

    const requestParams = {
      model: this.model,
      messages: openAIMessages,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: options?.temperature ?? 1,
      tools: options?.tools?.length ? options.tools : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };

    logger.info(`[OpenAIClient] Request params: ${JSON.stringify({ ...requestParams, messages: `[${requestParams.messages.length} messages]` })}`, undefined, 'OpenAIClient');

    const stream = await this.client.chat.completions.create(
      requestParams,
      options?.signal ? { signal: options.signal } : undefined,
    ) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;

    // Track multiple tool calls by index (OpenAI streams tool_calls with index)
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string; started: boolean; previewSignature: string }>();
    // For parsing MiniMax <think> tags embedded in text
    let thinkBuffer = '';
    let isInThinkTag = false;
    let hasExtractedThinkContent = false;
    const MAX_THINK_BUFFER_LENGTH = 10000; // Max buffer size before flushing
    const THINK_TAG_PATTERN = /<(think|thinking|thought)[^>]*>/i;
    const THINK_CLOSE_PATTERN = /<\/(think|thinking|thought)>/i;

    let eventCount = 0;
    let accumulatedUsage: { input_tokens: number; output_tokens: number; total_tokens?: number } | null = null;
    for await (const event of stream) {
      eventCount++;
      const delta = event.choices[0]?.delta;
      const finishReason = event.choices[0]?.finish_reason;

      // Collect usage from stream chunks (OpenAI sends usage in the final chunk when stream_options.include_usage is true)
      if ((event as unknown as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage) {
        const usage = (event as unknown as { usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
        accumulatedUsage = {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens,
        };
      }

      if (eventCount === 1) {
         logger.info(`[OpenAIClient] Received first stream event`, undefined, 'OpenAIClient');
       }

      if (!delta) continue;

      // Handle native reasoning_content / reasoning field (DeepSeek-R1, Qwen3, GLM-4.6, etc.)
      // Some providers stream reasoning incrementally via delta.reasoning_content,
      // others send it as a single string on delta.reasoning. Yield both as thinking events
      // so they render in ThinkingRow. Only check string types to avoid OpenAI SDK type errors.
      const reasoningDelta = (delta as { reasoning_content?: unknown }).reasoning_content;
      const reasoningFull = (delta as { reasoning?: unknown }).reasoning;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        yield {
          type: 'thinking',
          data: reasoningDelta,
        };
      }
      if (typeof reasoningFull === 'string' && reasoningFull) {
        yield {
          type: 'thinking',
          data: reasoningFull,
        };
      }

      // Handle text content with MiniMax  tag parsing
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
                  data: extractedThinking,
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
          // Check if buffer could be a partial think tag (starts with '<').
          // If so, don't yield yet — wait for more data to confirm.
          // Cap at 100 chars to avoid indefinite buffering on non-tag content
          // that starts with '<' followed by tag-like characters.
          if (couldBeThinkTagPrefix(thinkBuffer) && thinkBuffer.length < 100) {
            // Potential partial think tag — keep buffering, don't yield yet.
            // Will be resolved when more data arrives (either the tag completes
            // and is detected above, or it's confirmed not to be a tag and
            // flushed below).
          } else {
            // Not a think tag — yield buffered content as text
            yield {
              type: 'text',
              data: thinkBuffer,
            };
            thinkBuffer = '';
          }
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
          let entry = toolCallsMap.get(idx);

          if (toolCall.function?.name) {
            if (!entry) {
              entry = {
                id: toolCall.id || crypto.randomUUID(),
                name: toolCall.function.name,
                arguments: '',
                started: false,
                previewSignature: '',
              };
              toolCallsMap.set(idx, entry);
            } else {
              entry.name = entry.name || toolCall.function.name;
              if (toolCall.id) entry.id = toolCall.id;
            }

            if (!entry.started) {
              entry.started = true;
              yield {
                type: 'tool_use_started',
                data: {
                  id: entry.id,
                  name: entry.name,
                  input: {},
                },
              };
            }

            if (entry.arguments) {
              const previewInput = extractToolInputPreview(entry.arguments);
              if (hasToolInputPreview(previewInput)) {
                const previewSignature = JSON.stringify(previewInput);
                if (previewSignature !== entry.previewSignature) {
                  entry.previewSignature = previewSignature;
                  yield {
                    type: 'tool_use_started',
                    data: {
                      id: entry.id,
                      name: entry.name,
                      input: previewInput,
                    },
                  };
                }
              }
            }
          }

          // Accumulate arguments
          if (toolCall.function?.arguments) {
            if (!entry) {
              entry = {
                id: toolCall.id || crypto.randomUUID(),
                name: '',
                arguments: '',
                started: false,
                previewSignature: '',
              };
              toolCallsMap.set(idx, entry);
            }
            if (entry) {
              entry.arguments += toolCall.function.arguments;
              if (entry.started && entry.name) {
                const previewInput = extractToolInputPreview(entry.arguments);
                if (hasToolInputPreview(previewInput)) {
                  const previewSignature = JSON.stringify(previewInput);
                  if (previewSignature !== entry.previewSignature) {
                    entry.previewSignature = previewSignature;
                    yield {
                      type: 'tool_use_started',
                      data: {
                        id: entry.id,
                        name: entry.name,
                        input: previewInput,
                      },
                    };
                  }
                }
              }
            }
          }
        }
      }

      // When the stream signals completion via finish_reason='tool_calls',
      // yield all accumulated tool calls. On finish_reason='stop', discard
      // any residual tool calls (the model didn't finalize them).
      if (finishReason === 'tool_calls') {
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
      } else if (finishReason === 'stop' && toolCallsMap.size > 0) {
        // Residual tool calls with finish_reason='stop' — log but don't yield
        // to avoid emitting tool_use events the model didn't finalize.
        logger.warn(
          `[OpenAIClient] Discarding ${toolCallsMap.size} residual tool call(s) with finish_reason='stop'`,
          { toolCallNames: Array.from(toolCallsMap.values()).map(e => e.name) },
          'OpenAIClient',
        );
        toolCallsMap.clear();
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

    // Yield result event with token usage before done
    if (accumulatedUsage) {
      yield {
        type: 'result',
        data: accumulatedUsage,
      };
    }

    yield { type: 'done' };
  }
}

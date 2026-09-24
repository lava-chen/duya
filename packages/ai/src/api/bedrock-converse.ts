/**
 * packages/ai/src/api/bedrock-converse.ts
 *
 * Plan 451 Phase 3: AWS Bedrock ConverseStream API protocol.
 *
 * Implements the Bedrock `converse-stream` operation with hand-rolled
 * AWS SigV4 signing (no AWS SDK dependency — uses `node:crypto` and the
 * global `fetch`). Parses SSE events and maps them onto the internal
 * `AssistantMessageEvent` flow; downstream `emit-sse.ts` lowers them
 * to the public `SSEEvent` shape consumed by `DuyaAgent`.
 *
 * Scope (Phase 3 MVP):
 *   - Text content blocks (streamed)
 *   - Tool use content blocks (streamed; toolUse.input is a JSON string)
 *   - Reasoning / thinking content blocks (Claude only — extended thinking)
 *   - stopReason: end_turn / tool_use / max_tokens / stop_sequence
 *   - usage metadata (input/output/cacheRead/cacheWrite tokens)
 *   - Authentication: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (default);
 *     optional AWS_SESSION_TOKEN for STS / cross-account roles.
 *
 * Out of scope (future phases):
 *   - Prompt caching breakpoints (Bedrock cachePoint injection)
 *   - Document / image input (handled by transport-level only)
 *   - Tool choice configuration (defaults to auto)
 *   - Region failover / multi-region inference profiles
 *   - Bearer-token authentication (AWS_BEARER_TOKEN_BEDROCK)
 *
 * Reference:
 *   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
 */

import type {
  createHash as _createHash,
  createHmac as _createHmac,
} from 'node:crypto';
import type {
  AIClient,
  AIClientOptions,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  MessageContent,
  SSEEvent,
  TextContent,
  ThinkingContent,
  TokenUsage,
  ToolResultContent,
  ToolUseContent,
} from '../types.js';
import { transformMessages } from './transform-messages.js';
import { emitSSE } from './emit-sse.js';

// =============================================================================
// AWS SigV4 (hand-rolled, node:crypto only)
//
// `node:crypto` is lazy-loaded so the file can be imported in the renderer
// without Vite externalizing it. Vite externalizes bare `node:` specifiers
// for browser bundles; by deferring the actual `require()` to call time we
// keep the provider metadata reachable in the renderer while only paying
// the Node-only cost in the main process (where Bedrock signing runs).
// =============================================================================

type CreateHash = typeof _createHash;
type CreateHmac = typeof _createHmac;

/** Lazy require — throws a clear error if called outside Node. */
function nodeCrypto(): { createHash: CreateHash; createHmac: CreateHmac } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('node:crypto') as typeof import('node:crypto');
  return { createHash: mod.createHash, createHmac: mod.createHmac };
}

/** SHA-256 hex digest of `body`. */
function sha256Hex(body: string | Uint8Array): string {
  const { createHash } = nodeCrypto();
  return createHash('sha256').update(body).digest('hex');
}

/** HMAC-SHA256 of `data` with `key`. */
function hmac(key: Buffer | string, data: string): Buffer {
  const { createHmac } = nodeCrypto();
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Derive the SigV4 signing key for a given (date, region, service) tuple.
 * Standard AWS SigV4 algorithm: kDate → kRegion → kService → kSigning.
 */
function getSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

export interface SigV4SigningParams {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region: string;
  readonly service?: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body: string;
  readonly now?: Date;
}

export interface SigV4Headers {
  readonly Authorization: string;
  readonly 'x-amz-date': string;
  readonly 'x-amz-content-sha256': string;
  readonly 'x-amz-security-token'?: string;
}

/**
 * Build the AWS SigV4 Authorization header for a Bedrock ConverseStream
 * request. Pure function — exported for tests.
 */
export function signBedrockRequest(params: SigV4SigningParams): SigV4Headers {
  const service = params.service ?? 'bedrock';
  const now = params.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(params.body);
  const host = params.host;
  const canonicalUri = params.path || '/';
  const queryParams = params.query ?? {};

  // Canonical query string (sorted by key).
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k] ?? '')}`)
    .join('&');

  // Required headers + any session token.
  const requiredHeaders: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    'content-type': 'application/json',
  };
  if (params.sessionToken) {
    requiredHeaders['x-amz-security-token'] = params.sessionToken;
  }
  const canonicalHeaders = Object.keys(requiredHeaders)
    .sort()
    .map((k) => `${k}:${requiredHeaders[k]}\n`)
    .join('');
  const signedHeaders = Object.keys(requiredHeaders).sort().join(';');

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${params.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(
    params.secretAccessKey,
    dateStamp,
    params.region,
    service,
  );
  const signature = hmac(signingKey, stringToSign).toString('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: SigV4Headers = {
    Authorization: authorization,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (params.sessionToken) {
    (out as { 'x-amz-security-token'?: string })['x-amz-security-token'] = params.sessionToken;
  }
  return out;
}

function formatAmzDate(d: Date): string {
  // ISO basic format: YYYYMMDDTHHMMSSZ
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// =============================================================================
// Bedrock ConverseStream wire types
// =============================================================================

/** Content block deltas emitted by Bedrock ConverseStream. */
export type BedrockConverseDelta =
  | { text: string }
  | { toolUse: { input: string } }
  | { reasoningContent: { text?: string; signature?: string; redactedThinking?: unknown } };

/** Reason that caused message stop. */
export type BedrockConverseStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filtered'
  | 'guardrail_intervened'
  | string;

/** Wire-format content blocks Bedrock accepts. (Plan 451 Phase 3 MVP: text + toolUse + toolResult.) */
export interface BedrockConverseRequest {
  messages: BedrockConverseMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools: Array<{
      toolSpec: {
        name: string;
        description?: string;
        inputSchema: { json: Record<string, unknown> };
      };
    }>;
  };
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface BedrockConverseMessage {
  role: 'user' | 'assistant';
  content: Array<BedrockConverseContentBlock>;
}

export type BedrockConverseContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }> | string; status?: 'success' | 'error' } };

/** Convert duya's internal Message[] into Bedrock's Converse format. */
function toBedrockMessages(messages: Message[]): BedrockConverseRequest['messages'] {
  const out: BedrockConverseMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // system handled separately
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ text: stringContent(m.content) }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content: BedrockConverseContentBlock[] = [];
      if (typeof m.content === 'string') {
        content.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') content.push({ text: b.text });
          else if (b.type === 'thinking') {
            // Preserve reasoning as wrapped text (official-harness parity).
            // Re-emitting native reasoningContent blocks would need the
            // provider-specific signature round-trip; dropping the content
            // instead starves the model of its own prior reasoning.
            if (b.thinking && b.thinking.trim()) {
              content.push({ text: `<|prior-thinking|>\n${b.thinking}\n<|/prior-thinking|>` });
            }
          } else if (b.type === 'tool_use') {
            content.push({
              toolUse: {
                toolUseId: b.id,
                name: b.name,
                input: b.input ?? {},
              },
            });
          }
        }
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      // Bedrock tool results belong to the user role with toolResult blocks.
      const contentBlocks: Array<{ text: string }> = [];
      let isError = false;
      if (typeof m.content === 'string') {
        contentBlocks.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') contentBlocks.push({ text: b.text });
          else if (b.type === 'tool_result') {
            const tr = b;
            if (tr.is_error) isError = true;
            if (typeof tr.content === 'string') contentBlocks.push({ text: tr.content });
          }
        }
      }
      out.push({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: m.tool_call_id ?? '',
              content: contentBlocks,
              status: isError ? 'error' : 'success',
            },
          },
        ],
      });
    }
  }
  return out;
}

function stringContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[image]';
      return '';
    })
    .join('');
}

// =============================================================================
// SSE parsing (Bedrock uses standard "data: <json>\n\n" frames)
// =============================================================================

interface SseEvent {
  bytes: Uint8Array;
  eventType?: string;
}

/** Minimal SSE parser — yields decoded data payloads. Handles multi-line
 *  events and trailing newlines. Tolerates CRLF and LF line endings. */
async function* parseSSE(
  reader: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }, void, void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of reader) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) yield ev;
    }
  }
  // Flush.
  if (buffer.trim().length > 0) {
    const ev = parseFrame(buffer);
    if (ev) yield ev;
  }
}

function parseFrame(frame: string): { event?: string; data: string } | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join('\n') };
}

// =============================================================================
// Event mapping (Bedrock → AssistantMessageEvent)
// =============================================================================

type AssistantContentBlock = TextContent | ThinkingContent | ToolUseContent;

class StreamAccumulator {
  /** Partial AssistantMessage — content blocks accumulated as events stream in. */
  readonly partial: AssistantMessage;
  /** Block being built (text or tool). Null between blocks. */
  private currentBlock: AssistantContentBlock | null = null;
  /** Index of the current block in `partial.content`. */
  private currentIndex = -1;

  constructor(modelId: string, providerId: string, baseUrl?: string) {
    this.partial = {
      role: 'assistant',
      content: [],
      api: 'bedrock',
      provider: providerId,
      model: modelId,
      usage: { input_tokens: 0, output_tokens: 0 },
      stopReason: 'completed',
      timestamp: Date.now(),
    } as AssistantMessage;
    if (baseUrl) {
      (this.partial as { baseUrl?: string }).baseUrl = baseUrl;
    }
  }

  /** Convert a Bedrock contentBlockStart to an internal AssistantMessageEvent. */
  startBlock(index: number, start: Record<string, unknown>): AssistantMessageEvent[] {
    this.currentIndex = index;
    if ('toolUse' in start) {
      const tu = start.toolUse as { toolUseId?: string; name?: string };
      const block: ToolUseContent = {
        type: 'tool_use',
        id: tu.toolUseId ?? '',
        name: tu.name ?? '',
        input: {},
      };
      this.currentBlock = block;
      this.partial.content[index] = block;
      return [{ type: 'toolcall_start', contentIndex: index, partial: this.partial }];
    }
    if ('reasoningContent' in start) {
      const block: ThinkingContent = { type: 'thinking', thinking: '' };
      this.currentBlock = block;
      this.partial.content[index] = block;
      return [{ type: 'thinking_start', contentIndex: index, partial: this.partial }];
    }
    // Empty start = text block.
    const block: TextContent = { type: 'text', text: '' };
    this.currentBlock = block;
    this.partial.content[index] = block;
    return [{ type: 'text_start', contentIndex: index, partial: this.partial }];
  }

  /** Convert a Bedrock contentBlockDelta to an internal event. */
  deltaBlock(index: number, delta: BedrockConverseDelta): AssistantMessageEvent[] {
    this.currentIndex = index;
    if ('text' in delta) {
      const block = (this.partial.content[index] as TextContent | undefined) ?? {
        type: 'text',
        text: '',
      };
      block.text += delta.text;
      this.partial.content[index] = block;
      return [{ type: 'text_delta', contentIndex: index, delta: delta.text, partial: this.partial }];
    }
    if ('toolUse' in delta) {
      const partialJson = delta.toolUse.input ?? '';
      const block = (this.partial.content[index] as ToolUseContent | undefined) ?? {
        type: 'tool_use',
        id: '',
        name: '',
        input: {},
      };
      // Bedrock tool inputs are streamed as partial JSON strings; we
      // surface each chunk as a delta event. Downstream consumers
      // (DuyaAgent) reassemble via partial-json parsing.
      (block as ToolUseContent & { _rawInput?: string })._rawInput =
        ((block as ToolUseContent & { _rawInput?: string })._rawInput ?? '') + partialJson;
      this.partial.content[index] = block;
      return [{ type: 'toolcall_delta', contentIndex: index, delta: partialJson, partial: this.partial }];
    }
    if ('reasoningContent' in delta) {
      const rc = delta.reasoningContent;
      // Redacted reasoning: an opaque payload with no text. Capture it on
      // the thinking block so it can replay as redacted_thinking — dropping
      // it breaks the reasoning chain on the next Converse round.
      if (rc.redactedThinking != null && typeof rc.redactedThinking !== 'string') {
        // Non-string payloads cannot be replayed verbatim; treat as absent.
        return [];
      }
      if (typeof rc.redactedThinking === 'string' && rc.redactedThinking) {
        const redactedBlock: ThinkingContent = {
          type: 'thinking',
          thinking: '',
          redacted: true,
          encrypted: rc.redactedThinking,
        };
        this.partial.content[index] = redactedBlock;
        return [];
      }
      const block = (this.partial.content[index] as ThinkingContent | undefined) ?? {
        type: 'thinking',
        thinking: '',
      };
      if (typeof rc.text === 'string') {
        block.thinking += rc.text;
        if (typeof rc.signature === 'string') block.thinkingSignature = rc.signature;
      }
      this.partial.content[index] = block;
      if (typeof rc.text === 'string') {
        return [{ type: 'thinking_delta', contentIndex: index, delta: rc.text, partial: this.partial }];
      }
    }
    return [];
  }

  /** Convert a Bedrock contentBlockStop to an internal event. */
  endBlock(index: number): AssistantMessageEvent[] {
    const block = this.partial.content[index];
    if (!block) return [];
    if (block.type === 'tool_use') {
      // Promote accumulated raw input to parsed object on block end.
      const raw = (block as ToolUseContent & { _rawInput?: string })._rawInput ?? '';
      let parsedInput: unknown = {};
      if (raw) {
        try {
          parsedInput = JSON.parse(raw);
        } catch {
          parsedInput = raw;
        }
      }
      block.input = parsedInput as Record<string, unknown>;
      delete (block as ToolUseContent & { _rawInput?: string })._rawInput;
      this.partial.content[index] = block;
      const toolCall: ToolUseContent = block;
      this.currentBlock = null;
      this.currentIndex = -1;
      return [{ type: 'toolcall_end', contentIndex: index, toolCall, partial: this.partial }];
    }
    if (block.type === 'thinking') {
      this.currentBlock = null;
      this.currentIndex = -1;
      return [{ type: 'thinking_end', contentIndex: index, content: block.thinking, partial: this.partial }];
    }
    // text
    const text = (block as TextContent).text;
    this.currentBlock = null;
    this.currentIndex = -1;
    return [{ type: 'text_end', contentIndex: index, content: text, partial: this.partial }];
  }

  /** Map a Bedrock stopReason to internal stopReason + done event. */
  done(reason: BedrockConverseStopReason): AssistantMessageEvent {
    const stopReason = mapStopReason(reason);
    this.partial.stopReason = stopReason;
    return { type: 'done', reason: stopReason ?? 'completed', message: this.partial };
  }

  /** Apply a Bedrock metadata usage block (fold into the assistant message's
   *  `usage` field; emit on the final `done` event). */
  usage(usage: BedrockUsage): void {
    this.partial.usage = {
      input_tokens: usage.inputTokens ?? 0,
      output_tokens: usage.outputTokens ?? 0,
      ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
      // TokenUsage canonical field names — DuyaAgent and the usage ledger
      // read cache_hit_tokens / cache_creation_tokens; private names
      // silently zero the cache accounting for this provider.
      ...(usage.cacheReadInputTokens !== undefined
        ? { cache_hit_tokens: usage.cacheReadInputTokens }
        : {}),
      ...(usage.cacheWriteInputTokens !== undefined
        ? { cache_creation_tokens: usage.cacheWriteInputTokens }
        : {}),
    };
  }
}

interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

function mapStopReason(reason: string): AssistantMessage['stopReason'] {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'error';
    default:
      return 'error';
  }
}

// =============================================================================
// Factory
// =============================================================================

export interface BedrockConverseClientOptions {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly region: string;
  /** Model id (e.g. 'anthropic.claude-sonnet-4-20250514-v1:0'). */
  readonly model: string;
  /** Override the default 'https://bedrock-runtime.<region>.amazonaws.com'. */
  readonly baseUrl?: string;
  /** Optional fetch override for tests / proxies. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Optional signal to abort the request. */
  readonly signal?: AbortSignal;
}

export function createBedrockConverseClient(opts: BedrockConverseClientOptions): AIClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('createBedrockConverseClient: global fetch is not available');
  }
  const host = opts.baseUrl
    ? new URL(opts.baseUrl).host
    : `bedrock-runtime.${opts.region}.amazonaws.com`;
  const baseUrl = opts.baseUrl ?? `https://${host}`;

  return {
    async *streamChat(
      messages: Message[],
      chatOptions?: {
        systemPrompt?: string;
        maxTokens?: number;
        temperature?: number;
        effort?: string;
        maxOutputTokens?: number;
        signal?: AbortSignal;
      },
    ): AsyncGenerator<SSEEvent, AssistantMessage, unknown> {
      const requestBody: BedrockConverseRequest = {
        messages: toBedrockMessages(messages),
      };
      if (chatOptions?.systemPrompt) {
        requestBody.system = [{ text: chatOptions.systemPrompt }];
      }
      const inferenceConfig: NonNullable<BedrockConverseRequest['inferenceConfig']> = {};
      const max = chatOptions?.maxOutputTokens ?? chatOptions?.maxTokens;
      if (max) inferenceConfig.maxTokens = max;
      if (chatOptions?.temperature !== undefined) inferenceConfig.temperature = chatOptions.temperature;
      if (Object.keys(inferenceConfig).length > 0) requestBody.inferenceConfig = inferenceConfig;

      const body = JSON.stringify(requestBody);
      const headers = signBedrockRequest({
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
        region: opts.region,
        method: 'POST',
        host,
        path: '/model/' + encodeURIComponent(opts.model) + '/converse-stream',
        body,
      });

      const response = await fetchImpl(baseUrl + '/model/' + encodeURIComponent(opts.model) + '/converse-stream', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          accept: 'application/vnd.amazon.eventstream',
        },
        body,
        signal: chatOptions?.signal ?? opts.signal,
      });

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => '');
        yield {
          type: 'error',
          data: `Bedrock HTTP ${response.status}: ${errText.slice(0, 200)}`,
          code: `bedrock.http.${response.status}`,
        };
        return {
          ...new StreamAccumulator(opts.model, 'bedrock').partial,
          stopReason: 'error',
        };
      }

      const acc = new StreamAccumulator(opts.model, 'bedrock', baseUrl);
      // Bedrock sends a series of event-typed SSE frames:
      //   event: messageStart / contentBlockStart / contentBlockDelta /
      //          contentBlockStop / messageStop / metadata / error
      // Data payload is JSON for each event type.
      //
      // Bedrock sends messageStop (done) BEFORE metadata (usage) on the
      // wire, but DuyaAgent stamps the assistant message from the `result`
      // event when it processes `done` — so the done event is held until
      // usage has landed and result is emitted ahead of it.
      let bufferedDone: SSEEvent | null = null;
      let sawDone = false;
      let resultEmitted = false;
      for await (const ev of parseSSE(response.body)) {
        const raw = ev.data;
        if (!raw) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const events = mapBedrockEvent(acc, parsed);
        for (const e of events) {
          const sse = emitSSE(e);
          if (!sse) continue;
          if (sse.type === 'done') {
            bufferedDone = sse;
            sawDone = true;
            continue;
          }
          yield sse;
        }
        // The metadata frame completes the round: flush result + done.
        if (
          bufferedDone && !resultEmitted && acc.partial.usage
          && (acc.partial.usage.input_tokens > 0 || acc.partial.usage.output_tokens > 0)
        ) {
          resultEmitted = true;
          yield { type: 'result', data: acc.partial.usage };
          yield bufferedDone;
          bufferedDone = null;
        }
      }

      // Surface the usage on the wire (SSE `result`) even when no metadata
      // frame followed the held done (or done never arrived).
      if (!resultEmitted && acc.partial.usage && (acc.partial.usage.input_tokens > 0 || acc.partial.usage.output_tokens > 0)) {
        resultEmitted = true;
        yield { type: 'result', data: acc.partial.usage };
      }
      if (bufferedDone) {
        yield bufferedDone;
        bufferedDone = null;
      }
      // If we never saw a `done` event, emit one with the current stopReason.
      if (!sawDone && acc.partial.stopReason === 'completed') {
        const doneEv = acc.done('end_turn');
        const sse = emitSSE(doneEv);
        if (sse) yield sse;
      }
      return acc.partial;
    },
  };
}

function mapBedrockEvent(
  acc: StreamAccumulator,
  parsed: Record<string, unknown>,
): AssistantMessageEvent[] {
  // Bedrock event payload shapes (from ConverseStream response):
  //   { messageStart: { role: 'assistant' } }
  //   { contentBlockStart: { start: {...}, contentBlockIndex: N } }
  //   { contentBlockDelta:  { delta: {...}, contentBlockIndex: N } }
  //   { contentBlockStop:   { contentBlockIndex: N } }
  //   { messageStop: { stopReason: '...' } }
  //   { metadata: { usage: {...}, metrics: {...} } }
  //   { internalServerException: {...} } | { validationException: {...} } | ...
  if ('messageStart' in parsed) {
    return [{ type: 'start', partial: acc.partial }];
  }
  if ('contentBlockStart' in parsed) {
    const cb = parsed.contentBlockStart as {
      start?: Record<string, unknown>;
      contentBlockIndex?: number;
    };
    const idx = cb.contentBlockIndex ?? 0;
    const start = cb.start ?? {};
    return acc.startBlock(idx, start);
  }
  if ('contentBlockDelta' in parsed) {
    const cb = parsed.contentBlockDelta as {
      delta?: BedrockConverseDelta;
      contentBlockIndex?: number;
    };
    if (!cb.delta) return [];
    return acc.deltaBlock(cb.contentBlockIndex ?? 0, cb.delta);
  }
  if ('contentBlockStop' in parsed) {
    const cb = parsed.contentBlockStop as { contentBlockIndex?: number };
    return acc.endBlock(cb.contentBlockIndex ?? 0);
  }
  if ('messageStop' in parsed) {
    const ms = parsed.messageStop as { stopReason?: string };
    return [acc.done((ms.stopReason ?? 'end_turn') as BedrockConverseStopReason)];
  }
  if ('metadata' in parsed) {
    const md = parsed.metadata as { usage?: BedrockUsage };
    if (md.usage) {
      acc.usage(md.usage);
      // Usage is folded into the assistant message; emit nothing here.
      return [];
    }
    return [];
  }
  // Error events (Bedrock sends these as exception types in the payload).
  if (
    'internalServerException' in parsed ||
    'validationException' in parsed ||
    'throttlingException' in parsed ||
    'accessDeniedException' in parsed ||
    'serviceUnavailableException' in parsed ||
    'modelStreamErrorException' in parsed
  ) {
    const errKey = Object.keys(parsed).find((k) => k.endsWith('Exception'));
    const errBody = errKey ? (parsed[errKey] as { message?: string }) : undefined;
    acc.partial.stopReason = 'error';
    return [
      {
        type: 'error',
        reason: errBody?.message ?? 'bedrock_error',
        error: acc.partial,
      },
    ];
  }
  return [];
}
/**
 * Tool-result vocabulary: the wire half of what a tool call returns.
 *
 * ## Why `ToolResult` is the one type that is split
 *
 * Everything else in `content.ts` moved whole. `ToolResult` cannot, because it
 * currently carries two of the four field classes at once:
 *
 *   - JSON fields (`result`, `duration_ms`, `metadata`, `images`, `blocks`,
 *     `structured`) that cross the wire and are stored verbatim, and
 *   - two `Promise` fields (`pendingExtraResult`, `pendingContext`) that are
 *     in-process handshakes with `StreamingToolExecutor`.
 *
 * A `Promise` has no JSON representation. Contract §A puts "Promise/Map/
 * functions into wire" in the protocol's forbidden column, so the Promise
 * fields cannot live here.
 *
 * ## What that means for the split
 *
 * `ToolResultWire` below is the whole JSON half, and it is what a transcript
 * row, an SSE `tool_result` frame, or a persisted checkpoint actually holds.
 * The runtime type is `ToolResultWire & DeferredToolExtras`, where
 * `DeferredToolExtras` is the two promises. That intersection is the *whole*
 * argument: no field is duplicated, nothing is renamed, and the wire type is
 * not a lossy projection — it is the same object minus the two fields that
 * were never on the wire to begin with.
 *
 * The explicit serializer (`toToolResultWire`) lives in `@duya/ai`, NOT here.
 * It is code, this package is types plus codecs with no behaviour beyond
 * framing, and a serializer in the protocol would be the first step towards
 * the "pure data package that quietly pulls in behaviour" failure this
 * package exists to prevent.
 *
 * @see ./classification.ts for the field-by-field record
 */

import type { MessageContent, ToolGroupProgressSource } from './content.js';

export type { ToolGroupProgressSource };

/**
 * Tool invocation as carried on a `tool_use` content block and as the `data`
 * of the `tool_use_started` / `tool_use` SSE frames.
 */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  groupId?: string;
  progressTitle?: string;
  progressSource?: ToolGroupProgressSource;
}

/**
 * Free-form structured result metadata. Deliberately open: browser search and
 * parallel_fetch add their own keys and the renderer reads them generically.
 *
 * The index signature is the reason this cannot be a closed protocol type
 * without a schema per tool, and that schema is out of scope here.
 */
export interface ToolResultMetadata {
  durationMs?: number;
  filePath?: string;
  lineCount?: number;
  charCount?: number;
  exitCode?: number;
  matchCount?: number;
  truncated?: boolean;
  engine?: string;
  [key: string]: unknown;
}

/** One inline image attachment, as produced by ReadTool and ComputerUseTool. */
export interface ToolResultImage {
  data: string;
  mediaType: string;
}

/**
 * The JSON half of a tool result. This is the type a consumer of the wire
 * should use; `RuntimeToolResult` is the runtime-only intersection.
 *
 * Note `error?: boolean`. It is kept as-is rather than upgraded to the event
 * vocabulary's `ToolCallOutcome` because changing it would change what the
 * transcript says about every historical tool call. The protocol's
 * `ToolCallOutcome` exists to stop NEW producers from inventing a false
 * success; retro-fitting it onto stored rows would fabricate an outcome for
 * every call whose producer simply omitted the bit. See
 * `../events/payloads.ts` on `ToolCallOutcome` for the full argument.
 */
export interface ToolResultWire {
  id: string;
  name: string;
  result: string;
  error?: boolean;
  duration_ms?: number;
  metadata?: ToolResultMetadata;
  /** Inline image attachments; the executor builds `MessageContent[]` from these. */
  images?: ToolResultImage[];
  /**
   * Canonical MCP content blocks, verbatim from the server's `tools/call`
   * result. Persisted losslessly; the model-facing `result` text receives only
   * a bounded single-line metadata line per non-text block. Never stringified
   * into `result` — image/audio base64 payloads would eat hundreds of
   * thousands of tokens for zero benefit.
   */
  blocks?: unknown[];
  /** `structuredContent` from the MCP `tools/call` result, verbatim. */
  structured?: unknown;
}

/**
 * The two in-process handshake fields, and nothing else.
 *
 * They are runtime-only by construction: `pendingExtraResult` is awaited by
 * `StreamingToolExecutor` to yield a synthetic second `tool_result` after the
 * main one is delivered, and `pendingContext` is surfaced as a
 * `deferredContext` update so the agent can inject transient runtime context
 * on the next provider turn — never persisted to durable history.
 *
 * Declared here, in the protocol, so the *absence* is documented and typed:
 * a consumer that imports `ToolResultWire` cannot reach these, and one that
 * needs them must import the runtime intersection. The runtime type itself is
 * `RuntimeToolResult`, declared in `@duya/ai` where the executor lives.
 */
export interface DeferredToolExtras {
  /**
   * Optional deferred second result. When present, StreamingToolExecutor
   * keeps a reference and, after the main result has been delivered, awaits
   * this promise and yields a synthetic second tool_result.
   */
  pendingExtraResult?: Promise<{ result: string; is_error?: boolean }>;
  /**
   * Optional deferred context associated with a tool result. When present,
   * StreamingToolExecutor surfaces it as a `deferredContext` update so the
   * agent can inject it as transient runtime context on the next provider
   * turn (never persisted to the durable history). Resolves to a string or
   * JSON-serializable value (e.g. a follow-up review payload).
   */
  pendingContext?: Promise<unknown>;
}

/**
 * Content block a tool result builds when it has image attachments.
 *
 * Declared so `ToolResultWire.images` and `MessageContent` stay connected at
 * the type level instead of by convention: the executor turns `images` into
 * `[TextContent, ...ImageContent[]]` and nothing checks that today.
 */
export type ToolResultContentParts = readonly [string, ...MessageContent[]];

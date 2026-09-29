// packages/plugin-core/src/mcp/core/error-taxonomy.ts
// Plan 580 D9 — MCP error classification and circuit-breaker disposition.
//
// Two orthogonal pure functions:
//   1) `classifyMcpError` — DESCRIBE what happened (five classes).
//   2) `breakerDisposition` — decide the AVAILABILITY impact of a class.
//
// Rationale (plan 580 §D9): a JSON-RPC error response is the server's
// NORMAL answer — it is not an availability signal. A per-tool timeout
// does not mean the whole connection is unhealthy. Only transport
// failures and malformed protocol responses justify opening the
// connection-level circuit breaker.

/**
 * Stable error codes surfaced to the model through ToolResult text.
 * Chain A catch blocks and the chain B executor translation layer both
 * map onto these; the strings are part of the model-facing contract.
 */
export type McpErrorCode =
  | 'MCP_TRANSPORT'
  | 'MCP_TIMEOUT'
  | 'MCP_PROTOCOL'
  | 'MCP_AUTH_REQUIRED'
  | 'MCP_TOOL_ERROR';

/** The five error classes (plan 580 §D9 table). */
export type McpErrorClass = 'transport' | 'timeout' | 'protocol' | 'auth' | 'business';

/** Availability impact ruling (plan 580 §D9). */
export type BreakerDisposition = 'connection' | 'tool-scoped' | 'ignore';

/** Map an error class to its stable error code. */
export function errorCodeForClass(cls: McpErrorClass): McpErrorCode {
  switch (cls) {
    case 'transport': return 'MCP_TRANSPORT';
    case 'timeout': return 'MCP_TIMEOUT';
    case 'protocol': return 'MCP_PROTOCOL';
    case 'auth': return 'MCP_AUTH_REQUIRED';
    case 'business': return 'MCP_TOOL_ERROR';
  }
}

/**
 * A typed MCP error carrying a stable code. Thrown by Core primitives
 * (e.g. `listAllTools`) and by the chains when translating raw
 * transport errors. The `code` rides the message so downstream
 * surfaces (ToolResult text, logs) keep the stable token.
 */
export class McpError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options ? { cause: options.cause } : undefined);
    this.name = 'McpError';
    this.code = code;
  }
}

/** True when `err` is an McpError (or an error-shaped object with a known code). */
export function getMcpErrorCode(err: unknown): McpErrorCode | undefined {
  if (err instanceof McpError) return err.code;
  if (err && typeof err === 'object') {
    const candidate = (err as { code?: unknown }).code;
    if (
      candidate === 'MCP_TRANSPORT' ||
      candidate === 'MCP_TIMEOUT' ||
      candidate === 'MCP_PROTOCOL' ||
      candidate === 'MCP_AUTH_REQUIRED' ||
      candidate === 'MCP_TOOL_ERROR'
    ) {
      return candidate;
    }
  }
  return undefined;
}

const TRANSPORT_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bENOTFOUND\b/i,
  /\bEPIPE\b/i,
  /\bEPROTO\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /connection (reset|closed|refused|terminated)/i,
  /transport (closed|error)/i,
  /server unreachable/i,
  /stream (ended|closed) unexpectedly/i,
  /\baborted\b/i,
];

const PROTOCOL_PATTERNS: RegExp[] = [
  /invalid response schema/i,
  /failed to (parse|decode)/i,
  /malformed/i,
  /unexpected (end of )?json/i,
  /invalid json/i,
];

const TIMEOUT_PATTERNS: RegExp[] = [
  /timed?\s*out/i,
  /request timeout/i,
];

/**
 * Classify a thrown error into one of the five classes. Only
 * describes; never decides availability (see `breakerDisposition`).
 *
 * Precedence:
 *   1) our own McpError code (authoritative),
 *   2) SDK `UnauthorizedError` / 401 markers → auth,
 *   3) SDK `McpError` (JSON-RPC error response — the server's normal
 *      answer) → business,
 *   4) timeout text patterns → timeout,
 *   5) malformed-response patterns → protocol,
 *   6) transport text patterns → transport,
 *   7) unknown → transport (fail-closed for availability purposes).
 */
export function classifyMcpError(err: unknown): McpErrorClass {
  const ownCode = getMcpErrorCode(err);
  if (ownCode) {
    switch (ownCode) {
      case 'MCP_TRANSPORT': return 'transport';
      case 'MCP_TIMEOUT': return 'timeout';
      case 'MCP_PROTOCOL': return 'protocol';
      case 'MCP_AUTH_REQUIRED': return 'auth';
      case 'MCP_TOOL_ERROR': return 'business';
    }
  }

  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    const message = err instanceof Error ? err.message : String((err as { message?: unknown }).message ?? '');
    // MCP SDK auth error: name === 'UnauthorizedError' (HTTP 401 during
    // OAuth resource discovery / token attachment).
    if (name === 'UnauthorizedError' || /(^|\b)unauthorized(\b|$)/i.test(message)) {
      return 'auth';
    }
    // The SDK throws `McpError` for JSON-RPC error responses (it carries a
    // numeric JSON-RPC `code` property). A well-formed error response is
    // the server's normal answer — class `business`, not `protocol`.
    const jsonRpcCode = (err as { code?: unknown }).code;
    if (typeof jsonRpcCode === 'number' || /^MCP error -?\d+/.test(message)) {
      return 'business';
    }
    if (TIMEOUT_PATTERNS.some((p) => p.test(message))) return 'timeout';
    if (PROTOCOL_PATTERNS.some((p) => p.test(message))) return 'protocol';
    if (TRANSPORT_PATTERNS.some((p) => p.test(message))) return 'transport';
  }

  return 'transport';
}

/**
 * Availability ruling for an error class (plan 580 §D9):
 *   - transport / protocol → connection-level breaker (the existing one),
 *   - timeout → tool-scoped counter (key `connection:tool`),
 *   - auth / business → ignore (reauth card / plain model-visible error).
 */
export function breakerDisposition(cls: McpErrorClass): BreakerDisposition {
  switch (cls) {
    case 'transport': return 'connection';
    case 'protocol': return 'connection';
    case 'timeout': return 'tool-scoped';
    case 'auth': return 'ignore';
    case 'business': return 'ignore';
  }
}

/** Convenience: classify + rule in one call. */
export function breakerDispositionForError(err: unknown): { cls: McpErrorClass; disposition: BreakerDisposition } {
  const cls = classifyMcpError(err);
  return { cls, disposition: breakerDisposition(cls) };
}

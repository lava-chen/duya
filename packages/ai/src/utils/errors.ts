/**
 * LLM API Error Classification and Types
 *
 * Provides error type definitions and classification logic for API errors,
 * including retryable error detection and error message formatting.
 */

import type { SSEEvent } from '../types.js';

/**
 * API Error types that can be classified
 */
export enum APIErrorType {
  // Connection errors
  CONNECTION_ERROR = 'connection_error',
  TIMEOUT_ERROR = 'timeout_error',
  SSL_ERROR = 'ssl_error',
  DNS_ERROR = 'dns_error',

  // HTTP status errors
  RATE_LIMIT = 'rate_limit',           // 429
  SERVER_OVERLOAD = 'server_overload', // 529
  AUTH_ERROR = 'auth_error',           // 401/403
  NOT_FOUND = 'not_found',             // 404
  SERVER_ERROR = 'server_error',       // 5xx
  CLIENT_ERROR = 'client_error',       // 4xx

  // Context errors
  CONTEXT_LENGTH_EXCEEDED = 'context_length_exceeded',
  PROMPT_TOO_LONG = 'prompt_too_long',

  // Usage / quota errors
  USAGE_LIMIT = 'usage_limit',
  /**
   * Account has no money / no resource pack left (Plan 462).
   *
   * Providers frequently reuse HTTP 429 for this even though it is not a
   * transient rate limit — e.g. Zhipu GLM returns
   * `429 {"error":{"code":"1113","message":"[1113][余额不足或无可用资源包,请充值。]"}}`.
   * Retrying never helps: the balance only changes when the user pays. Keeping
   * it distinct from USAGE_LIMIT lets the UI render the provider's own wording
   * ("请充值") instead of a generic "usage limit reached".
   */
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  PROVIDER_SAFETY_FILTER = 'provider_safety_filter',

  // Other
  UNKNOWN = 'unknown',
  ABORTED = 'aborted',
}

/**
 * Extended API Error class with additional metadata
 */
export class LLMAPIError extends Error {
  public readonly type: APIErrorType;
  public readonly statusCode?: number;
  public readonly retryAfter?: number;  // seconds
  public readonly isRetryable: boolean;
  public readonly rawError: unknown;

  constructor(options: {
    message: string;
    type: APIErrorType;
    statusCode?: number;
    retryAfter?: number;
    isRetryable: boolean;
    rawError?: unknown;
  }) {
    super(options.message);
    this.name = 'LLMAPIError';
    this.type = options.type;
    this.statusCode = options.statusCode;
    this.retryAfter = options.retryAfter;
    this.isRetryable = options.isRetryable;
    this.rawError = options.rawError;
  }
}

/**
 * SSL/TLS error codes from OpenSSL
 */
const SSL_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
]);

/**
 * Connection error codes that indicate network issues
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/**
 * Transport-level stream-death message fragments. Aggregator routes
 * (OpenRouter et al.) drop mid-stream connections far more often than
 * direct endpoints, and those deaths surface as plain errors with no HTTP
 * status and no error `code`: undici throws bare `TypeError: terminated`
 * when a response body closes early, `fetch failed` on socket-level
 * aborts, and OpenRouter wraps upstream failures in text like
 * "Provider returned error". Without these patterns such errors classify
 * as UNKNOWN → non-retryable, so one upstream hiccup kills the whole turn.
 *
 * Matched only AFTER the HTTP-status switch, so status-bearing responses
 * keep their own semantics (a 400 whose message happens to contain one of
 * these fragments still classifies as CLIENT_ERROR).
 */
const TRANSPORT_STREAM_ERROR_PATTERNS = [
  'terminated',                                            // undici premature body close
  'fetch failed',
  'premature close',
  'prematurely closed',
  'other side closed',
  'socket hang up',
  'connection lost',
  'connection closed',
  'connection reset',
  'connection error',
  'network error',
  'provider returned error',                               // OpenRouter upstream-failure wrapper
  'exceeded request buffer limit while retrying upstream', // OpenRouter buffer overflow
  'stream ended without finish_reason',                    // openai-completions premature-end guard
  'ended before message_stop',                             // anthropic-protocol premature end
];

/**
 * Billing-shortfall markers (Plan 462).
 *
 * Several Chinese providers (Zhipu GLM, Moonshot, DashScope…) answer with
 * HTTP 429 when the account is out of money or out of resource packs. A 429
 * is normally a transient rate limit, so without these markers the retry loop
 * burns all attempts on an error that can only be fixed by paying.
 *
 * Matched case-insensitively against the raw error message (which includes
 * the response body), so both JSON-wrapped and plain-text forms are covered.
 */
const BILLING_SHORTFALL_PATTERNS = [
  '余额不足',
  '无可用资源包',
  '可用额度不足',
  '账户余额',
  '请充值',
  '欠费',
  'insufficient balance',
  'insufficient_balance',
  'balance is not enough',
  'balance not enough',
  'out of balance',
  'no available resource pack',
  'no available quota',
  'payment required',
  'prepaid balance',
];

/**
 * Strip the `[code]` / `[requestId]` noise providers wrap around the real
 * message, e.g.
 * `[1113][余额不足或无可用资源包,请充值。][20260830103053d5cdf3ab34bf42fc]`
 * → `余额不足或无可用资源包，请充值。`
 */
function stripBracketNoise(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('[')) return trimmed;

  const groups = [...trimmed.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim());
  if (groups.length === 0) return trimmed;

  // Drop pure numeric error codes and hex-ish request/trace ids; keep the
  // first remaining group — that is the human-readable sentence.
  const meaningful = groups.filter(
    (g) => g.length > 0 && !/^\d+$/.test(g) && !/^[0-9a-f]{16,}$/i.test(g),
  );
  if (meaningful.length === 0) return trimmed;
  return meaningful[0].replace(/[，,]\s*$/, '').trim();
}

/**
 * Extract the provider's own human-readable error message.
 *
 * Provider SDKs usually stringify the whole HTTP failure into
 * `error.message`, e.g.:
 *
 *   429 {"type":"error","error":{"code":"1113","message":"[1113][余额不足…]"}}
 *
 * Showing that verbatim is unreadable. This walks past the status-code prefix,
 * parses the JSON body, and drills into the conventional message fields, so
 * callers can surface just `余额不足或无可用资源包，请充值。`.
 *
 * Returns `undefined` when nothing better than the raw message can be found.
 */
export function extractProviderErrorMessage(error: unknown): string | undefined {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;
  if (!raw) return undefined;

  let current = raw.trim();
  for (let depth = 0; depth < 4; depth++) {
    // Strip a leading HTTP status prefix ("429 ") and any JSON wrapper.
    const body = current.replace(/^\d{3}\s+/, '');
    if (!body.startsWith('{')) break;

    let parsed: {
      error?: { message?: string; msg?: string };
      data?: { message?: string };
      message?: string;
      msg?: string;
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      break;
    }

    const next =
      parsed.error?.message ??
      parsed.error?.msg ??
      parsed.message ??
      parsed.data?.message ??
      parsed.msg;
    if (!next || next.trim() === current) break;
    current = next.trim();
  }

  if (current === raw.trim()) return undefined;

  const cleaned = stripBracketNoise(current);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * True when the message says the account is out of money / resource packs.
 */
export function isBillingShortfallMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return BILLING_SHORTFALL_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Extract error code from error object
 */
function extractErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  // Walk the cause chain
  let current: unknown = error;
  const maxDepth = 5;
  let depth = 0;

  while (current && depth < maxDepth) {
    if (current instanceof Error && 'code' in current) {
      const code = (current as { code?: string }).code;
      if (typeof code === 'string') return code;
    }

    if (current instanceof Error && 'cause' in current && current.cause !== current) {
      current = current.cause;
      depth++;
    } else {
      break;
    }
  }

  return undefined;
}

/**
 * Extract retry-after header value from error
 */
function extractRetryAfter(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  // Check for retry-after in headers
  const err = error as {
    headers?: { 'retry-after'?: string } | Headers;
    response?: { headers?: { 'retry-after'?: string } };
  };

  const retryAfterStr =
    (err.headers && 'get' in err.headers && typeof err.headers.get === 'function'
      ? err.headers.get('retry-after')
      : undefined) ||
    (err.headers && 'retry-after' in err.headers ? err.headers['retry-after'] : undefined) ||
    (err.response?.headers?.['retry-after']);

  if (retryAfterStr) {
    const seconds = parseInt(retryAfterStr, 10);
    if (!isNaN(seconds)) return seconds;
  }

  return undefined;
}

/**
 * Extract status code from error
 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;

  const err = error as { status?: number; statusCode?: number; response?: { status?: number } };

  return err.status ?? err.statusCode ?? err.response?.status;
}

/**
 * Check if error is an abort error
 *
 * Detection order (most reliable first):
 * 1. error.name === 'AbortError' — standard DOMException / AbortController
 * 2. error.code === 'ABORT_ERR' — Node.js fetch abort
 * 3. Case-insensitive message fallback — covers SDK-wrapped errors that
 *    don't propagate name/code. Kept specific to avoid false positives.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // 1. Standard AbortController / DOMException name
  if (error.name === 'AbortError') return true;

  // 2. Node.js fetch abort sets code = 'ABORT_ERR'
  const code = (error as { code?: string }).code;
  if (code === 'ABORT_ERR') return true;

  // 3. Fallback: case-insensitive message check for SDK-wrapped errors
  //    that don't propagate name/code. Kept specific to avoid false positives.
  const lowerMsg = error.message.toLowerCase();
  return lowerMsg.includes('aborterror') || lowerMsg.includes('aborted');
}

/**
 * Check if error indicates a stale connection (ECONNRESET/EPIPE)
 */
export function isStaleConnectionError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code === 'ECONNRESET' || code === 'EPIPE';
}

/**
 * Classify an error into APIErrorType
 */
export function classifyError(error: unknown): APIErrorType {
  if (isAbortError(error)) {
    return APIErrorType.ABORTED;
  }

  const statusCode = extractStatusCode(error);
  const errorCode = extractErrorCode(error);

  // Check for SSL errors
  if (errorCode && SSL_ERROR_CODES.has(errorCode)) {
    return APIErrorType.SSL_ERROR;
  }

  // Check for connection errors
  if (errorCode && CONNECTION_ERROR_CODES.has(errorCode)) {
    if (errorCode === 'ETIMEDOUT') {
      return APIErrorType.TIMEOUT_ERROR;
    }
    if (errorCode === 'ENOTFOUND') {
      return APIErrorType.DNS_ERROR;
    }
    return APIErrorType.CONNECTION_ERROR;
  }

  // Billing shortfall (Plan 462). Checked BEFORE the status-code switch:
  // providers reuse 429/402/403 for "out of money", and a 429 would
  // otherwise be classified as a transient rate limit and retried 10 times.
  if (error instanceof Error && isBillingShortfallMessage(error.message)) {
    return APIErrorType.INSUFFICIENT_BALANCE;
  }

  // Check for usage / quota limit errors in message
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('insufficient_quota') ||
      msg.includes('quota exceeded') ||
      msg.includes('billing hard limit') ||
      msg.includes('usage limit') ||
      msg.includes('quota limit reached') ||
      msg.includes('exceeded your current quota')
    ) {
      return APIErrorType.USAGE_LIMIT;
    }
    if (
      msg.includes('context_length_exceeded') ||
      msg.includes('context window exceeds limit')
    ) {
      return APIErrorType.CONTEXT_LENGTH_EXCEEDED;
    }
    if (msg.includes('prompt_too_long') || msg.includes('prompt is too long')) {
      return APIErrorType.PROMPT_TOO_LONG;
    }
    if (
      msg.includes('new_sensitive') ||
      msg.includes('output new_sensitive') ||
      msg.includes('sensitive content') ||
      msg.includes('content policy')
    ) {
      return APIErrorType.PROVIDER_SAFETY_FILTER;
    }
  }

  // Classify by HTTP status code
  if (statusCode !== undefined) {
    switch (statusCode) {
      case 401:
      case 403:
        return APIErrorType.AUTH_ERROR;
      case 404:
        return APIErrorType.NOT_FOUND;
      case 408:
        return APIErrorType.TIMEOUT_ERROR;
      case 409:
        return APIErrorType.CLIENT_ERROR;
      case 429:
        return APIErrorType.RATE_LIMIT;
      case 529:
        return APIErrorType.SERVER_OVERLOAD;
      default:
        if (statusCode >= 500) {
          return APIErrorType.SERVER_ERROR;
        }
        if (statusCode >= 400) {
          return APIErrorType.CLIENT_ERROR;
        }
    }
  }

  // Check for overloaded error in message
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('overloaded') || msg.includes('"type":"overloaded_error"')) {
      return APIErrorType.SERVER_OVERLOAD;
    }

    // Status-less transport-level stream death (mid-stream connection drop
    // from the provider/aggregator). See TRANSPORT_STREAM_ERROR_PATTERNS.
    if (TRANSPORT_STREAM_ERROR_PATTERNS.some((pattern) => msg.includes(pattern))) {
      return APIErrorType.CONNECTION_ERROR;
    }
  }

  return APIErrorType.UNKNOWN;
}

/**
 * Detect a schema-mismatch rejection: the endpoint's content-block schema
 * does not accept one of the blocks duya emitted (e.g. standard Anthropic
 * `tool_result` on the DeepSeek /anthropic compat surface, which only knows
 * `text | tool_reference | image | document`). These rejections are
 * deterministic per endpoint — retrying the same payload never succeeds — so
 * the caller should degrade the tool transport instead (Plan 418).
 */
export function isToolSchemaMismatchError(error: unknown): boolean {
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined && statusCode !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  // Without an HTTP 400 status, only the strong deserialization markers
  // count — a local error that merely mentions "unknown variant" is not an
  // endpoint schema rejection and must not trigger a transport degrade.
  if (statusCode === undefined) {
    return (
      message.includes('deserializ') ||
      message.includes('Failed to parse JSON body')
    );
  }
  return (
    message.includes('unknown variant') ||
    message.includes('deserializ') ||
    message.includes('Failed to parse JSON body')
  );
}

/**
 * Determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  // Abort errors are not retryable
  if (isAbortError(error)) {
    return false;
  }

  const type = classifyError(error);

  // These error types are retryable
  const retryableTypes = new Set([
    APIErrorType.CONNECTION_ERROR,
    APIErrorType.TIMEOUT_ERROR,
    APIErrorType.RATE_LIMIT,
    APIErrorType.SERVER_OVERLOAD,
    APIErrorType.SERVER_ERROR,
  ]);

  // Usage/quota limits are never retryable — user must switch model or wait
  // for the billing period to reset.
  if (type === APIErrorType.USAGE_LIMIT) {
    return false;
  }

  // Out of money / out of resource packs (Plan 462). Retrying only burns the
  // user's time — the balance never recovers on its own.
  if (type === APIErrorType.INSUFFICIENT_BALANCE) {
    return false;
  }

  // Provider safety filters are never retryable — the same input will
  // trigger the same filter again, so retrying just wastes time and
  // confuses the user.
  if (type === APIErrorType.PROVIDER_SAFETY_FILTER) {
    return false;
  }

  if (retryableTypes.has(type)) {
    return true;
  }

  // Check status code directly
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    // Retry on specific status codes
    if ([408, 429, 500, 502, 503, 529].includes(statusCode)) {
      return true;
    }
  }

  // Check for x-should-retry header
  if (error && typeof error === 'object') {
    const err = error as { headers?: { get?: (name: string) => string | null } };
    const shouldRetry = err.headers?.get?.('x-should-retry');
    if (shouldRetry === 'true') {
      return true;
    }
  }

  return false;
}

/**
 * Create LLMAPIError from unknown error
 */
export function createLLMAPIError(error: unknown): LLMAPIError {
  // If already an LLMAPIError, return it
  if (error instanceof LLMAPIError) {
    return error;
  }

  const type = classifyError(error);
  const statusCode = extractStatusCode(error);
  const retryAfter = extractRetryAfter(error);
  const isRetryable = isRetryableError(error);

  let message = 'Unknown API error';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }

  return new LLMAPIError({
    message,
    type,
    statusCode,
    retryAfter,
    isRetryable,
    rawError: error,
  });
}

/**
 * Format error for user display
 */
export function formatErrorForDisplay(error: unknown): string {
  const llmError = error instanceof LLMAPIError ? error : createLLMAPIError(error);

  switch (llmError.type) {
    case APIErrorType.CONNECTION_ERROR:
      return 'Unable to connect to API. Please check your internet connection.';
    case APIErrorType.TIMEOUT_ERROR:
      return 'Request timed out. The server is taking too long to respond.';
    case APIErrorType.SSL_ERROR:
      return 'SSL certificate error. If you are behind a corporate proxy, check your SSL settings.';
    case APIErrorType.DNS_ERROR:
      return 'DNS lookup failed. Please check your network connection.';
    case APIErrorType.RATE_LIMIT:
      return 'Rate limit exceeded. Please wait a moment before trying again.';
    case APIErrorType.USAGE_LIMIT:
      return 'Usage limit reached. Please switch to a different model or wait for the quota to reset.';
    case APIErrorType.INSUFFICIENT_BALANCE:
      // Plan 462: show what the provider actually said ("余额不足，请充值")
      // rather than a generic sentence — the user needs to know to top up.
      return (
        extractProviderErrorMessage(llmError.rawError ?? error) ??
        'Account balance is insufficient. Please top up your provider account.'
      );
    case APIErrorType.SERVER_OVERLOAD:
      return 'Server is overloaded. Please try again in a few moments.';
    case APIErrorType.AUTH_ERROR:
      return 'Authentication failed. Please check your API key or login again.';
    case APIErrorType.NOT_FOUND:
      return 'The requested model or endpoint was not found.';
    case APIErrorType.SERVER_ERROR:
      return 'Server error occurred. Please try again later.';
    case APIErrorType.CONTEXT_LENGTH_EXCEEDED:
    case APIErrorType.PROMPT_TOO_LONG:
      return 'The conversation is too long. Please start a new session or compact the history.';
    case APIErrorType.PROVIDER_SAFETY_FILTER:
      return 'The model provider stopped the response because its safety filter flagged newly generated output. Previous tool work and files are kept; you can continue with a safer wording or switch models.';
    case APIErrorType.ABORTED:
      return 'Request was cancelled.';
    default:
      return llmError.message || 'An unexpected error occurred.';
  }
}

/**
 * Create SSE error event
 */
export function createErrorEvent(error: unknown): SSEEvent {
  const llmError = error instanceof LLMAPIError ? error : createLLMAPIError(error);

  let code: string | undefined;
  if (llmError.type === APIErrorType.RATE_LIMIT) {
    code = 'rate_limit_error';
  } else if (llmError.type === APIErrorType.USAGE_LIMIT) {
    code = 'usage_limit_exceeded';
  } else if (llmError.type === APIErrorType.INSUFFICIENT_BALANCE) {
    code = 'insufficient_balance';
  } else if (llmError.type === APIErrorType.PROVIDER_SAFETY_FILTER) {
    code = 'provider_safety_filter';
  }

  return {
    type: 'error',
    data: formatErrorForDisplay(error),
    code,
    metadata: {
      errorType: llmError.type,
      statusCode: llmError.statusCode,
      isRetryable: llmError.isRetryable,
    },
  } as SSEEvent;
}

/**
 * Create SSE retry event for UI display.
 *
 * Plan 462: the notice carries the provider's own reason so the UI can render
 * e.g. `余额不足或无可用资源包，请充值。（重新连接 1/10）` instead of an opaque
 * "Retrying... (1/10)".
 *
 * `data` holds only the reason (or the legacy English fallback) — the
 * attempt counter stays in `metadata` so each surface (Electron renderer,
 * CLI) can compose its own localized suffix instead of inheriting a
 * hard-coded one from this low-level package.
 */
export function createRetryEvent(
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  reason?: string,
  errorType?: string,
  statusCode?: number,
): SSEEvent {
  const retryReason = reason?.trim();
  return {
    type: 'system',
    data: retryReason || `Retrying... (${attempt}/${maxAttempts})`,
    metadata: {
      retryAttempt: attempt,
      maxAttempts,
      retryDelayMs: delayMs,
      retryReason,
      errorType,
      statusCode,
    },
  } as SSEEvent;
}
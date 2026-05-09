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
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.name === 'AbortError' ||
    error.message.includes('aborted') ||
    error.message.includes('AbortError')
  );
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

  // Check for context length errors in message
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('context_length_exceeded') ||
      msg.includes('context window exceeds limit')
    ) {
      return APIErrorType.CONTEXT_LENGTH_EXCEEDED;
    }
    if (msg.includes('prompt_too_long') || msg.includes('prompt is too long')) {
      return APIErrorType.PROMPT_TOO_LONG;
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
        return APIErrorType.SERVER_ERROR;
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
  }

  return APIErrorType.UNKNOWN;
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

  if (retryableTypes.has(type)) {
    return true;
  }

  // Check status code directly
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    // Retry on specific status codes
    if ([408, 409, 429, 500, 502, 503, 529].includes(statusCode)) {
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

  return {
    type: 'error',
    data: formatErrorForDisplay(error),
    metadata: {
      errorType: llmError.type,
      statusCode: llmError.statusCode,
      isRetryable: llmError.isRetryable,
    },
  } as SSEEvent;
}

/**
 * Create SSE retry event for UI display
 */
export function createRetryEvent(attempt: number, maxAttempts: number, delayMs: number): SSEEvent {
  return {
    type: 'system',
    data: `Retrying... (${attempt}/${maxAttempts})`,
    metadata: {
      retryAttempt: attempt,
      maxAttempts,
      retryDelayMs: delayMs,
    },
  } as SSEEvent;
}

/**
 * context-compressor.ts - DEPRECATED Context compression integration
 *
 * This module is kept for backward compatibility but is no longer the primary
 * compaction path. The new compaction system uses CompactionManager with LLM
 * summarization wired through the Agent constructor.
 *
 * The agent process's `compact` handler (agent-process-entry.ts) uses
 * `agent.compact()` which goes through CompactionManager.
 *
 * @deprecated Use CompactionManager via Agent.compact() instead.
 */

import {
  estimateContextTokens,
  needsCompression,
  DEFAULT_CONTEXT_WINDOW,
  COMPRESSION_THRESHOLD,
} from '@duya/agent';

/**
 * Circuit breaker: max consecutive compression failures per session
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface CompressionCheckResult {
  shouldCompress: boolean;
  estimatedTokens: number;
  contextWindow: number;
  percentFull: number;
}

// Track consecutive failures per session for circuit breaker
const consecutiveFailures = new Map<string, number>();

/**
 * Resets the consecutive failure counter for a session.
 * Called after successful compression.
 */
export function resetCompressionFailure(sessionId: string): void {
  consecutiveFailures.delete(sessionId);
}

/**
 * Gets the current consecutive failure count for a session.
 */
export function getCompressionFailureCount(sessionId: string): number {
  return consecutiveFailures.get(sessionId) || 0;
}

/**
 * Increments the consecutive failure counter for a session.
 * Returns true if circuit breaker should trip (max failures reached).
 */
export function incrementCompressionFailure(sessionId: string): boolean {
  const current = consecutiveFailures.get(sessionId) || 0;
  const next = current + 1;
  consecutiveFailures.set(sessionId, next);
  return next >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * Checks if context compression should be performed and optionally compresses.
 *
 * @param messages - Array of messages to check and potentially compress
 * @param sessionId - Session ID for circuit breaker tracking
 * @param apiKey - Anthropic API key for LLM summarization
 * @param model - Optional model override for summarization (defaults to haiku)
 * @returns Object containing whether compression happened and result details
 */
export async function checkAndCompress(
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
  _apiKey: string,
  _model?: string
): Promise<{ didCompress: boolean; result?: { summary: string; messagesCompressed: number; estimatedTokensSaved: number }; error?: string }> {
  const failureCount = getCompressionFailureCount(sessionId);
  if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
    return {
      didCompress: false,
      error: `Circuit breaker open: ${failureCount} consecutive failures`,
    };
  }

  const estimate = estimateContextTokens(messages);

  console.log(`[Context Compressor DEPRECATED] Session ${sessionId}: ${estimate.percentFull.toFixed(1)}% full. Use CompactionManager via Agent.compact() instead.`);

  return { didCompress: false };
}

/**
 * Gets a summary message describing the compression result.
 */
export function getCompressionSummaryMessage(result: { messagesCompressed: number; estimatedTokensSaved: number }): string {
  return `Context compressed. ${result.messagesCompressed} messages condensed, approximately ${Math.round(result.estimatedTokensSaved / 4)} tokens saved.`;
}

export { estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD };

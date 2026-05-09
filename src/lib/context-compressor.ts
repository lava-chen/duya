/**
 * context-compressor.ts - Context compression integration for API routes
 *
 * This module provides the bridge between the API route and the compact module,
 * handling automatic context compression when the conversation exceeds 80% of
 * the context window.
 */

import {
  estimateContextTokens,
  needsCompression,
  compactHistory,
  DEFAULT_CONTEXT_WINDOW,
  COMPRESSION_THRESHOLD,
  type CompactResult,
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
  apiKey: string,
  model?: string
): Promise<{ didCompress: boolean; result?: CompactResult; error?: string }> {
  // Check circuit breaker
  const failureCount = getCompressionFailureCount(sessionId);
  if (failureCount >= MAX_CONSECUTIVE_FAILURES) {
    return {
      didCompress: false,
      error: `Circuit breaker open: ${failureCount} consecutive failures`,
    };
  }

  // Estimate context tokens
  const estimate = estimateContextTokens(messages);
  const contextCheck: CompressionCheckResult = {
    shouldCompress: needsCompression(estimate),
    estimatedTokens: estimate.totalTokens,
    contextWindow: estimate.contextWindow,
    percentFull: estimate.percentFull,
  };

  // Log for debugging
  console.log(`[Context Compressor] Session ${sessionId}: ${contextCheck.percentFull.toFixed(1)}% full (${contextCheck.estimatedTokens} / ${contextCheck.contextWindow} tokens)`);

  // Only compress if needed
  if (!contextCheck.shouldCompress) {
    return { didCompress: false };
  }

  // Perform compression
  try {
    const result = await compactHistory(
      messages as Parameters<typeof compactHistory>[0],
      {
        apiKey,
        model: model || '', // Must provide model explicitly
        maxMessagesToKeep: 20, // Preserve recent messages
      }
    );

    // Reset failure counter on success
    resetCompressionFailure(sessionId);

    return {
      didCompress: true,
      result,
    };
  } catch (error) {
    // Increment failure counter
    const circuitBroken = incrementCompressionFailure(sessionId);

    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Context Compressor] Compression failed for session ${sessionId}: ${errorMessage}`);

    if (circuitBroken) {
      console.error(`[Context Compressor] Circuit breaker opened for session ${sessionId} after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
    }

    return {
      didCompress: false,
      error: circuitBroken
        ? `Compression circuit breaker opened after ${MAX_CONSECUTIVE_FAILURES} failures`
        : errorMessage,
    };
  }
}

/**
 * Gets a summary message describing the compression result.
 */
export function getCompressionSummaryMessage(result: CompactResult): string {
  return `Context compressed. ${result.messagesCompressed} messages condensed, approximately ${Math.round(result.estimatedTokensSaved / 4)} tokens saved.`;
}

export { estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD };

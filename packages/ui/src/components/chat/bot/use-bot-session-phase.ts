/**
 * Plan 491 P0.3: Bot session phase state machine hook.
 *
 * Derives a UI-friendly session phase from the stream session snapshot:
 *   - idle:       no active stream / no activity
 *   - thinking:   extended thinking content is being received
 *   - tool:       a tool is actively being used
 *   - streaming:  text is streaming
 *   - waiting_approval: awaiting user permission
 *   - error:      an error occurred
 */

import type { SessionStreamSnapshot } from '@/types/message';

export type BotSessionPhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'streaming'
  | 'waiting_approval'
  | 'error';

/**
 * Derive the bot session phase from a stream session snapshot.
 * Takes the latest snapshot and determines the most relevant UI phase.
 */
export function deriveBotSessionPhase(snapshot: SessionStreamSnapshot): BotSessionPhase {
  // Error state takes priority
  if (snapshot.error || snapshot.phase === 'error') {
    return 'error';
  }

  // Waiting for approval
  if (snapshot.phase === 'awaiting_permission') {
    return 'waiting_approval';
  }

  // Tool usage: check if there's an active tool call without result
  if (snapshot.toolUses && snapshot.toolUses.length > 0) {
    // If there are tool results, the tool call is complete
    // We could check for "in-progress" tool calls, but for simplicity,
    // if there are tool calls and no final message, show tool state
    if (!snapshot.finalMessageContent && snapshot.phase !== 'idle') {
      return 'tool';
    }
  }

  // Thinking: if there's thinking content, show thinking state
  if (snapshot.streamingThinkingContent && snapshot.streamingThinkingContent.length > 0) {
    return 'thinking';
  }

  // Streaming: if we're in streaming phase with text
  if (snapshot.phase === 'streaming' || snapshot.phase === 'starting') {
    if (snapshot.streamingContent && snapshot.streamingContent.length > 0) {
      return 'streaming';
    }
    // Even with no text yet, if streaming phase is active, show streaming
    if (snapshot.phase === 'streaming') {
      return 'streaming';
    }
  }

  // Default to idle
  return 'idle';
}

/**
 * useBotSessionPhase — React hook that derives the bot session phase
 * from a stream session snapshot.
 *
 * Usage:
 *   const phase = useBotSessionPhase(sessionSnapshot);
 */
export function useBotSessionPhase(snapshot: SessionStreamSnapshot | null): BotSessionPhase {
  if (!snapshot) {
    return 'idle';
  }
  return deriveBotSessionPhase(snapshot);
}

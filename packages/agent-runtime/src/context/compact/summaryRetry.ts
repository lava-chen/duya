/**
 * Summary retry ladder (Plan 495 G4; grok self-summary alignment).
 *
 * Grok's `self-summary-handler.ts` retries a failing summarization up to
 * 3 times with a deterministic escalation ladder instead of failing the
 * whole compaction: an output-length error gets a one-shot "shorter output"
 * instruction appended to the prompt, an input-length error shrinks the
 * summarization input (dropping tool traffic first), and transient errors
 * retry unchanged. This module ports that ladder as pure functions over the
 * duya strategy's serialized-input pipeline.
 */

import type { Message } from '../types.js'
import { SummaryDegenerateError } from './compactErrors.js'

/** Maximum summarization attempts (first call + retries). Grok: 3. */
export const MAX_SUMMARY_RETRIES = 3

/**
 * Backoff before a retry after a transient (network / 5xx / rate-limit)
 * failure. Grok: TRANSIENT_SELF_SUMMARY_RETRY_DELAY_MS = 2_000 — without it
 * the ladder hammers a failing endpoint three times back-to-back.
 */
export const TRANSIENT_RETRY_DELAY_MS = 2_000

/**
 * Tool-message share above which the input reduction drops tool traffic
 * wholesale instead of cutting the middle half. Grok: 0.25.
 */
export const TOOL_MESSAGE_DROP_THRESHOLD = 0.25

export type SummaryErrorKind = 'output_length' | 'input_length' | 'transient' | 'fatal'

/**
 * Classify a summarizer failure into a retry action.
 *
 * Classification is message-based (the summarizer is injected and may throw
 * provider SDK errors of any shape): token-limit keywords win, then network
 * / 5xx / timeout markers map to transient, everything else is fatal.
 */
export function classifySummaryError(err: unknown): SummaryErrorKind {
  const message = err instanceof Error ? err.message : String(err)
  const lowered = message.toLowerCase()
  if (
    lowered.includes('output') && (lowered.includes('max_tokens') || lowered.includes('length')) ||
    lowered.includes('max_output_tokens') ||
    lowered.includes('output_token_limit')
  ) {
    return 'output_length'
  }
  if (
    lowered.includes('context_length_exceeded') ||
    lowered.includes('input too large') ||
    lowered.includes('input_token_limit') ||
    lowered.includes('input tokens exceed') ||
    lowered.includes('prompt is too long') ||
    lowered.includes('maximum context length')
  ) {
    return 'input_length'
  }
  if (
    lowered.includes('timeout') ||
    lowered.includes('econnreset') ||
    lowered.includes('econnrefused') ||
    lowered.includes('etimedout') ||
    /\b(5\d\d)\b/.test(message) ||
    lowered.includes('overloaded') ||
    lowered.includes('rate limit')
  ) {
    return 'transient'
  }
  return 'fatal'
}

/**
 * One-shot instruction appended to the prompt so the next attempt produces
 * a materially shorter summary. Grok appends `SHORTER_OUTPUT_RETRY_PROMPT`
 * to the last prompt message; duya's summarizer takes (text, prompt) with
 * the prompt last, so appending here is the same contract.
 */
export function appendShorterOutputInstruction(prompt: string): string {
  return `${prompt}\n\nYour previous response was cut off by the output token limit. Write a much shorter summary: at most half the length, keep only the decisions, file paths, and pending work needed to continue.`
}

function isToolishMessage(msg: Message): boolean {
  if (msg.role === 'tool') return true
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(
    (b) => (b as { type?: string }).type === 'tool_use' || (b as { type?: string }).type === 'tool_result',
  )
}

function stripToolBlocks(msg: Message): Message {
  if (!Array.isArray(msg.content)) return msg
  const kept = msg.content.filter((b) => {
    const type = (b as { type?: string }).type
    return type !== 'tool_use' && type !== 'tool_result'
  })
  if (kept.length === msg.content.length) return msg
  return { ...msg, content: kept }
}

/**
 * Shrink the summarization input while preserving the conversation's shape:
 * the first message (conversation anchor) and the last message (the summary
 * request itself, appended by the caller) are always kept verbatim.
 *
 * Mirrors grok `reduceSelfSummaryInputMessages`:
 * - tool traffic ≥ TOOL_MESSAGE_DROP_THRESHOLD of the middle → drop tool
 *   messages and tool_use/tool_result blocks from the middle entirely;
 * - a single middle message → keep its second half;
 * - otherwise → drop the first half of the middle (skipping leading tool
 *   messages so the new middle head is not a dangling tool_result).
 */
export function reduceSummaryInputs(messages: readonly Message[]): Message[] {
  if (messages.length <= 2) return [...messages]
  const head = messages[0]!
  const prompt = messages[messages.length - 1]!
  const middle = messages.slice(1, -1)

  const toolCount = middle.filter(isToolishMessage).length
  if (toolCount > 0 && toolCount / middle.length >= TOOL_MESSAGE_DROP_THRESHOLD) {
    const kept = middle.filter((m) => !isToolishMessage(m)).map(stripToolBlocks)
    if (kept.length > 0) return [head, ...kept, prompt]
    // Everything in the middle was tool traffic — fall through to halving.
  }

  if (middle.length === 1) {
    const only = middle[0]!
    if (typeof only.content === 'string' && only.content.length >= 2) {
      return [head, { ...only, content: only.content.slice(Math.floor(only.content.length / 2)) }, prompt]
    }
    return [...messages]
  }

  let keepFrom = Math.floor(middle.length / 2)
  while (keepFrom < middle.length && isToolishMessage(middle[keepFrom]!)) {
    keepFrom++
  }
  return [head, ...middle.slice(keepFrom), prompt]
}

export interface SummaryRetryContext {
  /** Conversation payload serialized for the summarizer. */
  conversationText: string
  /** Summarization prompt (instructions; last call's message). */
  prompt: string
  /** Raw source messages — the reduction input for input_length retries. */
  messages: readonly Message[]
  /**
   * Rebuild (conversationText, prompt) from a (possibly reduced) message
   * list. Provided by the strategy so the ladder stays decoupled from the
   * serialization format.
   */
  rebuild: (reduced: readonly Message[]) => { conversationText: string; prompt: string }
}

export interface SummaryRetryOutcome {
  text: string
  attempts: number
}

/** Plan 523 P6: per-attempt result reported via {@link summarizeWithRetryLadder}'s onAttempt. */
export interface SummaryAttemptReport {
  attempt: number
  outcome: 'success' | 'degenerate' | 'empty' | 'error'
  errorKind?: string
  chars: number
}

/**
 * Run the retry ladder. `run` performs one summarization attempt and throws
 * on failure; an empty string counts as a degenerate result and retries
 * like any other failure (grok retries empty content as well). `isDegenerate`
 * lets the caller keep its own degeneracy detector.
 *
 * Contract note: an *error* exhausts the ladder by throwing, and (Plan 523)
 * an empty/degenerate result now also throws `SummaryDegenerateError` instead
 * of returning '' — so a summarizer that keeps producing degenerate output
 * fails the whole compaction, routing it into the suppression machine rather
 * than silently replacing real history with a zero-information placeholder.
 */
export async function summarizeWithRetryLadder(
  run: (conversationText: string, prompt: string) => Promise<string>,
  ctx: SummaryRetryContext,
  isDegenerate: (text: string) => boolean,
  onAttempt?: (report: SummaryAttemptReport) => void,
  opts?: { retryDelayMs?: number },
): Promise<SummaryRetryOutcome> {
  const retryDelayMs = opts?.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS
  let currentText = ctx.conversationText
  let currentPrompt = ctx.prompt
  let currentMessages: readonly Message[] = ctx.messages
  let shorterOutputRequested = false
  let lastError: unknown
  let lastWasDegenerate = false
  let lastDegenerateChars = 0

  for (let attempt = 1; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
    try {
      const text = await run(currentText, currentPrompt)
      const trimmed = text.trim()
      if (trimmed.length > 0 && !isDegenerate(text)) {
        onAttempt?.({ attempt, outcome: 'success', chars: text.length })
        return { text, attempts: attempt }
      }
      lastWasDegenerate = true
      lastDegenerateChars = text.length
      lastError = new Error('[summary-retry] empty or degenerate summary')
      onAttempt?.({
        attempt,
        outcome: trimmed.length > 0 ? 'degenerate' : 'empty',
        chars: text.length,
      })
    } catch (err) {
      lastWasDegenerate = false
      lastError = err
      const kind = classifySummaryError(err)
      onAttempt?.({ attempt, outcome: 'error', errorKind: kind, chars: 0 })
      if (kind === 'fatal') throw err
      if (kind === 'transient' && attempt < MAX_SUMMARY_RETRIES) {
        // Grok backs off before retrying a transient failure; only the last
        // attempt skips the wait (nothing follows it to back off for).
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
      if (kind === 'output_length' && !shorterOutputRequested) {
        currentPrompt = appendShorterOutputInstruction(currentPrompt)
        shorterOutputRequested = true
      } else if (kind === 'input_length') {
        const reduced = reduceSummaryInputs(currentMessages)
        if (reduced.length === currentMessages.length) throw err
        currentMessages = reduced
        const rebuilt = ctx.rebuild(reduced)
        currentText = rebuilt.conversationText
        currentPrompt = rebuilt.prompt
      }
    }
  }
  if (lastWasDegenerate) {
    throw new SummaryDegenerateError(MAX_SUMMARY_RETRIES, lastDegenerateChars)
  }
  throw lastError
}

/**
 * BackgroundPrefire (Plan 495 G1; grok two-pass summarization alignment).
 *
 * Grok starts a *background* summarization once token usage approaches the
 * compaction threshold and harvests the result when a real compaction fires
 * (`BackgroundSummarizationMode.Background` +
 * `BackgroundAndPersistIfCompleted`, summarization-orchestrator.ts). A
 * background result is only reused when its message snapshot is still a
 * *prefix* of the current messages — otherwise it is discarded as
 * `prefix_invalid` because it would summarize a range that no longer ends
 * where the current context begins.
 *
 * duya keeps this as a small collaborator owned by CompactionManager:
 * - `maybeStartPrefire` kicks a pass1 summarization (best-effort, never
 *   blocks or throws into the turn) once usage crosses
 *   `prefireStartFraction × compactThreshold`;
 * - `takeFreshPrefire` returns the completed pass1 text for the active
 *   compaction to consume as its `previousSummary` seed (turning pass2 into
 *   an iterative update instead of a full re-summarization), and clears the
 *   state;
 * - fingerprint = message-id list at start; valid only while it remains a
 *   prefix of the current id list.
 */

import type { Message } from '../types.js'

export interface PrefireConfig {
  /**
   * Fraction of the compaction threshold (maxTokens - reserveTokens) at
   * which the background pass starts. `0` disables prefire. Default 0.75
   * (plan 422's prefire lead point).
   */
  prefireStartFraction?: number
}

interface PrefireState {
  promise: Promise<string>
  /** Message ids of the projection the pass was started on. */
  fingerprint: readonly string[]
  startedAt: number
}

function messageIds(messages: readonly Message[]): string[] {
  return messages.map((m) => (typeof m.id === 'string' ? m.id : ''))
}

/** True when `prefix` is a strict prefix of `current` (element-wise). */
export function isPrefixFingerprint(prefix: readonly string[], current: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > current.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== current[i]) return false
  }
  return true
}

export class BackgroundPrefire {
  private state: PrefireState | null = null
  /** Completed, unconsumed pass1 result keyed by its fingerprint. */
  private completed: { text: string; fingerprint: readonly string[] } | null = null
  private readonly startFraction: number

  constructor(config?: PrefireConfig) {
    this.startFraction = config?.prefireStartFraction ?? 0.75
  }

  get enabled(): boolean {
    return this.startFraction > 0
  }

  /**
   * Start the background pass1 when `usedTokens` crosses the prefire
   * threshold. No-op when disabled, already in flight, or already holding a
   * fresh unconsumed result. The summarize function must never throw
   * synchronously; a rejected promise is swallowed (best-effort pass).
   */
  maybeStart(
    usedTokens: number,
    compactThreshold: number,
    messages: readonly Message[],
    summarize: (messages: readonly Message[]) => Promise<string>,
  ): void {
    if (!this.enabled) return
    if (compactThreshold <= 0 || usedTokens < this.startFraction * compactThreshold) return
    const fingerprint = messageIds(messages)
    if (fingerprint.length === 0) return
    // A completed-but-stale result must not block a fresh start.
    if (this.completed && !isPrefixFingerprint(this.completed.fingerprint, fingerprint)) {
      this.completed = null
    }
    if (this.state || this.completed) return
    const promise = Promise.resolve()
      .then(() => summarize(messages))
      .then((text): string => {
        // Only keep the result when its fingerprint is still valid — a
        // compaction that landed mid-pass rewrites the id list.
        if (this.state && this.state.fingerprint === fingerprint) {
          this.completed = { text, fingerprint }
        }
        this.state = null
        return text
      })
      .catch(() => {
        if (this.state && this.state.fingerprint === fingerprint) this.state = null
        return ''
      })
    this.state = { promise, fingerprint, startedAt: Date.now() }
    void promise
  }

  /** True when a pass1 result is completed and still prefix-valid. */
  hasFresh(messages: readonly Message[]): boolean {
    if (!this.completed) return false
    return isPrefixFingerprint(this.completed.fingerprint, messageIds(messages))
  }

  /**
   * Consume the fresh pass1 text, awaiting an in-flight pass when one covers
   * the current projection (grok `WaitForCompletionIfStarted` semantics for
   * the compaction that is about to run anyway). Returns undefined when the
   * pass is absent, still unstarted, or prefix-invalid.
   */
  async takeFresh(messages: readonly Message[]): Promise<string | undefined> {
    const currentIds = messageIds(messages)
    if (this.state) {
      if (!isPrefixFingerprint(this.state.fingerprint, currentIds)) {
        // Prefix invalid: the in-flight pass summarizes a superseded range.
        this.state = null
        return undefined
      }
      const state = this.state
      const text = await state.promise
      if (this.state === state) this.state = null
      return typeof text === 'string' && text.trim().length > 0 ? text : undefined
    }
    if (this.completed && isPrefixFingerprint(this.completed.fingerprint, currentIds)) {
      const text = this.completed.text
      this.completed = null
      return text.trim().length > 0 ? text : undefined
    }
    this.completed = null
    return undefined
  }

  clear(): void {
    this.state = null
    this.completed = null
  }

  /** Test seam. */
  isRunning(): boolean {
    return this.state !== null
  }
}

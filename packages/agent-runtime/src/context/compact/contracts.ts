/**
 * Neutral contracts for context evaluation and compaction effects.
 *
 * Runtime owns the decision policy, while the Host supplies the application's
 * canonical token estimator and context projection implementation.
 */
import type { Message } from '@duya/agent-protocol/transcript'

export interface ContextUsageBlock {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cache_hit_tokens?: number
  cache_creation_tokens?: number
  last_call?: ContextUsageBlock
}

export interface ContextEstimateMessage {
  role: string
  content: string | unknown[]
  usage?: ContextUsageBlock | null
  tokenUsage?: ContextUsageBlock | null
  stopReason?: string | null
  isCompactBoundary?: boolean
  model?: string | null
}

export interface ContextEstimateOptions {
  systemPrefixTokens?: number
  toolDefinitionsTokens?: number
}

export interface ContextEstimate {
  usedTokens: number | null
  anchored: boolean
  anchorIndex: number | null
  anchorTokens: number
  trailingTokens: number
  anchorModel: string | null
  toolDefinitionsTokens: number
}

export type ContextEstimateSource = 'provider' | 'anchor_projection' | 'tokenizer' | 'heuristic'
export type ContextWindowSource = 'capability' | 'catalog' | 'default'

export interface ContextObservation {
  inputTokens: number
  outputTokens: number
  source: 'provider'
  requestId: string
  observedAt: number
}

export interface ContextAccountingState {
  latestInputTokens?: number
  peakInputTokens?: number
  projectedNextInputTokens: number
}

export interface ContextSnapshot {
  schemaVersion: 1
  observation: ContextObservation | null
  accounting: ContextAccountingState
  estimateSource: ContextEstimateSource | 'unknown'
  confidence: 'authoritative' | 'derived' | 'heuristic'
  observedAt: number
  lastUpdatedAt: number
  anchorRequestId: string | null
  anchorTurnId: string | null
  modelId: string | null
  contextWindow: number
  windowSource: ContextWindowSource
  epoch: number
  lastObservationFollowedShrink: boolean
}

export interface LiveAnchorCorrectionInput {
  scanUsedTokens: number | null
  scanAnchorInputTokens: number
  scanAnchored: boolean
  timelineIncludesLiveObservation: boolean
  liveLatestInputTokens: number
  schemaDelta: number
  shrinkArmed: boolean
}

export interface LiveAnchorCorrectionResult {
  usedTokens: number
  replaced: boolean
  estimateSource: ContextEstimateSource | 'unknown'
}

export interface NormalizedPromptTokens {
  prompt: number
  output: number
}

/** Implemented by Host with the same model as the renderer's context ring. */
export interface ContextModelPort {
  estimateMessageTokens(message: ContextEstimateMessage): number
  estimateTextTokens(text: string): number
  computeContextEstimate(
    messages: readonly ContextEstimateMessage[],
    options?: ContextEstimateOptions,
  ): ContextEstimate
  normalizePromptTokens(usage: ContextUsageBlock | null | undefined): NormalizedPromptTokens
  applyLiveAnchorCorrection(input: LiveAnchorCorrectionInput): LiveAnchorCorrectionResult
}

export interface CompactionLoggerPort {
  debug(message: string, context?: Record<string, unknown>): void
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
}

export interface CompactionClockPort {
  now(): number
}

export interface CompactionRuntimePorts {
  contextModel: ContextModelPort
  logger: CompactionLoggerPort
  clock: CompactionClockPort
  /** Provider-backed summarization is an application effect injected by Host. */
  summarizer?: (text: string, prompt: string) => Promise<string>
  /**
   * A successful compaction rewrites the transcript, so any state anchored to
   * read results that were in the OLD context is no longer valid. Runtime owns
   * the decision (it knows the rewrite happened) but not the state (the
   * read-first ledger lives in Capabilities, which Runtime must not import).
   *
   * Host binds this to a SESSION-SCOPED invalidation: a worker serves several
   * sessions, and clearing every bucket would also erase a concurrently running
   * child session's ledger — the child's transcript was not rewritten by this
   * compaction. The callback takes no scope on purpose; Host closes over the
   * session id, keeping Runtime free of session identity.
   *
   * Optional so a Runtime-only test or a non-worker host can construct a
   * manager without participating in the read-first protocol.
   */
  onTranscriptRewrite?: () => void
}

export type CompactionMessage = Message

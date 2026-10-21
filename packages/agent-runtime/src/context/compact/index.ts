/**
 * Context Compaction System
 */

// Types
export * from './types.js'

// Token Budget
export { TokenBudgetManager, estimateMessageTokens, estimateMessagesTokens } from './tokenBudget.js'

// Compaction Manager
export {
  CompactionManager,
  createCompactionManager,
  type CompactionManagerConfig,
  type CompactionManagerEvent,
  type CompactionProbe,
  type EnhancedCompactionResult,
} from './CompactionManager.js'
export {
  ContextLedger,
  type ContextEpochReason,
  type ContextObservationInput,
  type ContextWindowInfo,
} from '../ContextLedger.js'
export {
  MessageCompactionController,
  type MessageCompactionControllerOptions,
  type CompactionManagerLike,
  type CompactProactiveOptions,
} from './message-compaction-controller.js'
export type * from './contracts.js'

// Strategies
export {
  SessionMemoryCompactStrategy,
  createSessionMemoryCompactStrategy,
  type SessionMemoryCompactConfig,
  type SkillInvocation,
  type FileChangeRecord,
  type SessionMemoryData,
} from './strategies/SessionMemoryCompactStrategy.js'

// Post-compact reinjection
export { PostCompactReinjector, createPostCompactReinjector, extractFileState, type FileStateEntry, type ReinjectorConfig, type ReinjectResult, type SkillContextEntry, type ToolState } from './PostCompactReinjector.js'

// Projection-layer tool compression pipeline (LLM-facing only).
// The canvas and micro transforms are owned by `projectionCompress` and its
// `transforms/` subdirectory; standalone duplicates were removed (the env
// switch now lives in `projectionCompress.ts`).
export {
  compressProjectedToolMessages,
  buildDefaultTransforms,
  DEFAULT_TRANSFORMS,
  DUYA_COMPRESS_CANVAS_HISTORY_ENV,
  type ProjectionTransform,
  type ProjectionPipelineConfig,
} from './projectionCompress.js'

// Tool-call invariant + budget fitting
export { sanitizeCompactedHistory, validateCompactedHistory, fitCompactedToBudget } from './historySanitize.js'

// Summary quality guard
export { cleanSummaryText, isDegenerateSummary, MIN_SUMMARY_CHARS } from './summaryGuard.js'

// Summary retry ladder (Plan 495 G4, grok self-summary alignment)
export {
  MAX_SUMMARY_RETRIES,
  TOOL_MESSAGE_DROP_THRESHOLD,
  classifySummaryError,
  appendShorterOutputInstruction,
  reduceSummaryInputs,
  summarizeWithRetryLadder,
  type SummaryErrorKind,
  type SummaryRetryContext,
  type SummaryRetryOutcome,
} from './summaryRetry.js'

// Background prefire (Plan 495 G1, grok two-pass alignment)
export { BackgroundPrefire, isPrefixFingerprint, type PrefireConfig } from './BackgroundPrefire.js'

// Image-parts compaction trigger (Plan 495 G2, grok alignment)
export {
  IMAGE_COMPACTION_TRIGGER_COUNT,
  countImagePartsInMessages,
} from './imageParts.js'

// Failure classification (plan 552: classification only — the suppression
// machine lives in CompactionManager.Suppression)
export {
  classifySuppressReason,
  suppressReasonMessage,
  SummaryDegenerateError,
  type SuppressReason,
} from './compactErrors.js'

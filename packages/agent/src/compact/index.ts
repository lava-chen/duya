/**
 * Context Compaction System
 */

// Types
export * from './types.js'

// Token Budget
export { TokenBudgetManager, estimateMessageTokens, estimateMessagesTokens } from './tokenBudget.js'

// Compaction Manager
export { CompactionManager, createCompactionManager, type CompactionManagerConfig, type CompactionManagerEvent } from './CompactionManager.js'

// Strategies
export { SessionMemoryCompactStrategy, createSessionMemoryCompactStrategy, type SessionMemoryCompactConfig } from './strategies/SessionMemoryCompactStrategy.js'

// Post-compact reinjection
export { PostCompactReinjector, createPostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'

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

// Failure classification + suppression
export {
  classifyCompactFailure,
  CompactSuppression,
  isRetryableCompactFailure,
  SUPPRESS_WINDOW_MS,
  type CompactFailureKind,
} from './compactErrors.js'

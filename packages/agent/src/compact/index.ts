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

// Micro cleanup for lightweight tool result pruning
export { microCleanupMessages } from './microCompactCleanup.js'

// Historical canvas tool-call compression (LLM-facing only)
export { compressHistoricalCanvasToolCalls } from './canvasHistoryCompress.js'
// Projection-layer tool compression pipeline (LLM-facing only)
export { compressProjectedToolMessages, DEFAULT_TRANSFORMS, type ProjectionTransform } from './projectionCompress.js'

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

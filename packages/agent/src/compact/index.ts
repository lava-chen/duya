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
export { MicroCompactStrategy, createMicroCompactStrategy, type MicroCompactConfig } from './strategies/MicroCompactStrategy.js'
export { SessionMemoryCompactStrategy, createSessionMemoryCompactStrategy, type SessionMemoryCompactConfig } from './strategies/SessionMemoryCompactStrategy.js'
export { SnipCompactStrategy, createSnipCompactStrategy, type SnipCompactConfig } from './strategies/SnipCompactStrategy.js'
export { ReactiveCompactStrategy, createReactiveCompactStrategy, type ReactiveCompactConfig } from './strategies/ReactiveCompactStrategy.js'

// Post-compact reinjection
export { PostCompactReinjector, createPostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'

// Micro cleanup for lightweight tool result pruning
export { microCleanupMessages } from './microCompactCleanup.js'

// Historical canvas tool-call compression (LLM-facing only)
export { compressHistoricalCanvasToolCalls } from './canvasHistoryCompress.js'

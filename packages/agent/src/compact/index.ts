/**
 * Context Compaction System
 */

// Types
export * from './types.js'

// Token Budget
export { TokenBudgetManager, createTokenBudget, estimateMessageTokens, estimateMessagesTokens, roughTokenCountEstimation } from './tokenBudget.js'

// Compaction Manager
export { CompactionManager, createCompactionManager, type CompactionManagerConfig, type CompactionManagerEvent } from './CompactionManager.js'

// Strategies
export { MicroCompactStrategy, createMicroCompactStrategy, type MicroCompactConfig } from './strategies/MicroCompactStrategy.js'
export { SessionMemoryCompactStrategy, createSessionMemoryCompactStrategy, type SessionMemoryCompactConfig } from './strategies/SessionMemoryCompactStrategy.js'
export { SnipCompactStrategy, createSnipCompactStrategy, type SnipCompactConfig } from './strategies/SnipCompactStrategy.js'
export { ReactiveCompactStrategy, createReactiveCompactStrategy, type ReactiveCompactConfig } from './strategies/ReactiveCompactStrategy.js'

// Post-compact reinjection
export { PostCompactReinjector, createPostCompactReinjector, type ReinjectorConfig, type SkillContextEntry } from './PostCompactReinjector.js'

// Legacy exports from compact.ts for backward compatibility
export { compactHistory, estimateContextTokens, needsCompression, DEFAULT_CONTEXT_WINDOW, COMPRESSION_THRESHOLD, type CompactResult, type TokenEstimation } from './compact.js'

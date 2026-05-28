/**
 * Hooks System for duya Agent
 *
 * Provides a hooks system for executing custom code at various points
 * during agent execution.
 */

// Types
export * from './types.js';

// Enhanced hooks (with LLM support and tool failure handling)
export * from './enhanced/types.js';
export { EnhancedHookRegistry } from './enhanced/EnhancedHookRegistry.js';
export { LLMPromptHook, createLLMEvalHook, DEFAULT_EVALUATION_PROMPT } from './enhanced/LLMPromptHook.js';
export { ToolFailureHook, createToolFailureHook, DEFAULT_TOOL_FAILURE_HOOK } from './enhanced/ToolFailureHook.js';

// Executors
export { executePromptHook } from './executors/prompt-executor.js';
export { executeHttpHook } from './executors/http-executor.js';
export { executeAgentHook } from './executors/agent-executor.js';
export {
  spawnAsyncHook,
  isAsyncHookRunning,
  cancelAsyncHook,
  getPendingAsyncHookCount,
  cancelAllAsyncHooks,
  registerRewakeCallback,
  unregisterRewakeCallback,
} from './executors/async-runner.js';

// Matcher
export {
  matchesMatcher,
  matchesIfCondition,
  sortByPriority,
  getPrioritizedMatches,
} from './matcher.js';

// Watcher
export { HookWatcher } from './watcher.js';

// Utils
export * from './utils/hooks.js';
export * from './utils/sessionHooks.js';

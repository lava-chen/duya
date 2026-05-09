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

// Utils
export * from './utils/hooks.js';
export * from './utils/sessionHooks.js';

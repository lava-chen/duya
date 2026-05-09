/**
 * Enhanced Hook System Types
 *
 * Extended hook system with LLM-driven evaluation and tool failure handling.
 */

import type { Message } from '../../types.js'

/**
 * Hook execution phases
 */
export enum HookPhase {
  PRE_PROMPT = 'pre_prompt',
  POST_PROMPT = 'post_prompt',
  PRE_TOOL = 'pre_tool',
  POST_TOOL = 'post_tool',
  ON_ERROR = 'on_error',
  ON_TOOL_FAILURE = 'on_tool_failure',
}

/**
 * Context passed to hooks during execution
 */
export interface HookContext {
  prompt?: string
  messages?: Message[]
  toolUse?: {
    id: string
    name: string
    input: Record<string, unknown>
  }
  toolResult?: {
    success: boolean
    result?: unknown
    error?: string
  }
  sessionId: string
  workspace: string
  [key: string]: unknown
}

/**
 * Result returned by hook execution
 */
export interface HookResponse {
  modified?: boolean
  modifiedContent?: string
  action: 'continue' | 'stop' | 'modify'
  metadata?: Record<string, unknown>
}

/**
 * Hook executor function type
 */
export type HookExecutor = (context: HookContext) => HookResponse | Promise<HookResponse>

/**
 * Tool failure context for ON_TOOL_FAILURE hook
 */
export interface ToolFailureContext {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  error: Error
  attemptNumber: number
  availableFallbacks?: string[]
}

/**
 * LLM evaluation result for prompt hooks
 */
export interface LLMEvaluationResult {
  passed: boolean
  modifiedContent?: string
  reasoning?: string
  action?: 'continue' | 'modify' | 'stop'
  confidence?: number
}

/**
 * Configuration for LLM-driven hooks
 */
export interface LLMEvalHookConfig {
  apiKey: string
  model?: string
  baseURL?: string
  evaluationPrompt: string
  threshold?: number
}

/**
 * Built-in hook phases for registration
 */
export const HOOK_PHASES = [
  HookPhase.PRE_PROMPT,
  HookPhase.POST_PROMPT,
  HookPhase.PRE_TOOL,
  HookPhase.POST_TOOL,
  HookPhase.ON_ERROR,
  HookPhase.ON_TOOL_FAILURE,
] as const

export type BuiltInHookPhase = (typeof HOOK_PHASES)[number]
/**
 * EnhancedHookRegistry - Hook registration and execution system
 *
 * Provides enhanced hook system with:
 * - Phase-based hook registration
 * - ON_TOOL_FAILURE phase for tool failure handling
 * - Batch hook registration
 * - LLM-driven evaluation support
 */

import { HookPhase, HOOK_PHASES } from './types.js'
import type {
  HookContext,
  HookExecutor,
  HookResponse,
  ToolFailureContext,
} from './types.js'

/**
 * Registered hook entry
 */
interface RegisteredHook {
  name: string
  executor: HookExecutor
  priority?: number
}

/**
 * EnhancedHookRegistry manages hooks across different execution phases.
 *
 * Usage:
 * ```typescript
 * const registry = new EnhancedHookRegistry()
 *
 * registry.registerHook(HookPhase.PRE_TOOL, 'validate_tool', async (ctx) => {
 *   // Validate tool input
 *   return { action: 'continue' }
 * })
 *
 * registry.registerHook(HookPhase.ON_TOOL_FAILURE, 'auto_retry', async (ctx) => {
 *   // Handle tool failure
 *   return { action: 'continue', modified: true }
 * })
 *
 * // Emit hooks for a phase
 * const result = await registry.emit(HookPhase.PRE_TOOL, context)
 * ```
 */
export class EnhancedHookRegistry {
  private hooks: Map<HookPhase, RegisteredHook[]> = new Map()
  private llmHooks: Map<HookPhase, string> = new Map()

  constructor() {
    // Initialize empty hook arrays for each phase
    for (const phase of HOOK_PHASES) {
      this.hooks.set(phase, [])
    }
  }

  /**
   * Register a hook for a specific phase
   */
  registerHook(phase: HookPhase, name: string, executor: HookExecutor, priority = 0): void {
    const phaseHooks = this.hooks.get(phase) || []
    phaseHooks.push({ name, executor, priority })
    // Sort by priority (higher first)
    phaseHooks.sort((a, b) => (b.priority || 0) - (a.priority || 0))
    this.hooks.set(phase, phaseHooks)
  }

  /**
   * Register multiple hooks at once
   */
  registerHooks(hooks: Record<HookPhase, HookExecutor[]>): void {
    for (const [phase, executors] of Object.entries(hooks)) {
      for (const executor of executors) {
        this.registerHook(phase as HookPhase, `hook_${Date.now()}`, executor)
      }
    }
  }

  /**
   * Register an LLM-driven hook with evaluation prompt
   */
  registerLLMHook(phase: HookPhase, prompt: string): void {
    this.llmHooks.set(phase, prompt)
  }

  /**
   * Emit hooks for a specific phase
   */
  async emit(phase: HookPhase, context: HookContext): Promise<HookContext> {
    const phaseHooks = this.hooks.get(phase) || []

    for (const hook of phaseHooks) {
      try {
        const result = await hook.executor(context)

        if (result.action === 'stop') {
          break
        }

        if (result.action === 'modify' && result.modifiedContent) {
          context = {
            ...context,
            modifiedContent: result.modifiedContent,
            modified: true,
          }
        }
      } catch (error) {
        console.error(`Hook ${hook.name} failed:`, error)
      }
    }

    return context
  }

  /**
   * Emit tool failure hooks with tool failure context
   */
  async emitToolFailure(context: ToolFailureContext): Promise<{
    shouldRetry: boolean
    fallbackTool?: string
    errorMessage?: string
  }> {
    const phaseHooks = this.hooks.get(HookPhase.ON_TOOL_FAILURE) || []

    let shouldRetry = false
    let fallbackTool: string | undefined
    let errorMessage: string | undefined

    // Build full HookContext with required fields
    const hookContext: HookContext = {
      sessionId: context.toolUseId, // Use toolUseId as sessionId placeholder
      workspace: '',
      toolUse: {
        id: context.toolUseId,
        name: context.toolName,
        input: context.toolInput,
      },
      toolResult: {
        success: false,
        error: context.error.message,
      },
    }

    for (const hook of phaseHooks) {
      try {
        const result = await hook.executor(hookContext)

        if (result.action === 'stop') {
          break
        }

        if (result.metadata) {
          if ('shouldRetry' in result.metadata) {
            shouldRetry = Boolean(result.metadata.shouldRetry)
          }
          if ('fallbackTool' in result.metadata) {
            fallbackTool = String(result.metadata.fallbackTool)
          }
          if ('errorMessage' in result.metadata) {
            errorMessage = String(result.metadata.errorMessage)
          }
        }
      } catch (error) {
        console.error(`Tool failure hook ${hook.name} failed:`, error)
      }
    }

    return { shouldRetry, fallbackTool, errorMessage }
  }

  /**
   * Get all registered hooks for a phase
   */
  getHooks(phase: HookPhase): RegisteredHook[] {
    return this.hooks.get(phase) || []
  }

  /**
   * Check if any hooks are registered for a phase
   */
  hasHooks(phase: HookPhase): boolean {
    const hooks = this.hooks.get(phase) || []
    return hooks.length > 0
  }

  /**
   * Remove a specific hook by name
   */
  removeHook(phase: HookPhase, name: string): void {
    const phaseHooks = this.hooks.get(phase) || []
    const filtered = phaseHooks.filter(h => h.name !== name)
    this.hooks.set(phase, filtered)
  }

  /**
   * Clear all hooks for a phase
   */
  clearHooks(phase: HookPhase): void {
    this.hooks.set(phase, [])
  }

  /**
   * Clear all hooks
   */
  clearAll(): void {
    for (const phase of HOOK_PHASES) {
      this.hooks.set(phase, [])
    }
    this.llmHooks.clear()
  }
}

export default EnhancedHookRegistry
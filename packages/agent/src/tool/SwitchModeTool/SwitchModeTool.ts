/**
 * SwitchModeTool - Switch between different agent behavioral modes
 * Unified replacement for EnterPlanModeTool/ExitPlanModeTool pattern
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import {
  SWITCH_MODE_TOOL_NAME,
  ALL_MODES,
  type AgentMode,
} from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { MODE_CONFIGS } from './modes.js'

const VALID_MODES = ['general', 'plan', 'explore', 'verify', 'code-review'] as const
type ValidMode = typeof VALID_MODES[number]

// Module-level state for backward compatibility with EnterPlanModeTool/ExitPlanModeTool
let currentMode: ValidMode = 'general'

export function getCurrentMode(): ValidMode {
  return currentMode
}

export function setAgentMode(mode: ValidMode): void {
  currentMode = mode
}

export function isReadOnlyMode(): boolean {
  return currentMode !== 'general'
}

export class SwitchModeTool implements Tool, ToolExecutor {
  readonly name = SWITCH_MODE_TOOL_NAME
  readonly description = DESCRIPTION
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: [...VALID_MODES],
        description: 'The mode to switch to',
      },
      reason: {
        type: 'string',
        description: 'Why you are switching modes',
      },
    },
    required: ['mode'],
  }

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    }
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const mode = input.mode as ValidMode
    if (!VALID_MODES.includes(mode)) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Invalid mode: ${mode}. Valid modes: ${VALID_MODES.join(', ')}`,
        }),
        error: true,
      }
    }

    const previousMode = currentMode
    const reason = input.reason as string | undefined

    // Update module-level state
    currentMode = mode

    // If context is available, also update the app state (for session-level persistence)
    if (context?.setAppState) {
      context.setAppState((prev) => ({
        ...prev,
        agentMode: mode,
      }))
    }

    const config = MODE_CONFIGS[mode as AgentMode]
    const result: Record<string, unknown> = {
      previousMode,
      currentMode: mode,
      readOnly: config.readOnly,
      message: this.getModeSwitchMessage(mode, previousMode, reason),
    }

    // Include guidance for the new mode
    if (config.systemPromptSuffix) {
      result.guidance = config.systemPromptSuffix.trim()
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(result),
    }
  }

  private getModeSwitchMessage(mode: ValidMode, previousMode: ValidMode, reason?: string): string {
    const reasonText = reason ? ` Reason: ${reason}` : ''

    if (mode === previousMode) {
      return `Already in ${mode} mode.${reasonText}`
    }

    const transitions: Record<string, string> = {
      'general->plan': 'Switched to PLAN mode. You can now explore and design.',
      'general->explore': 'Switched to EXPLORE mode. You can now search and investigate.',
      'general->verify': 'Switched to VERIFY mode. You can now run tests and verify.',
      'general->code-review': 'Switched to CODE REVIEW mode. You can now review code.',
      'plan->general': 'Exited plan mode. Ready for implementation.',
      'explore->general': 'Exited explore mode.',
      'verify->general': 'Exited verify mode.',
      'code-review->general': 'Exited code review mode.',
      'plan->explore': 'Switched from plan to explore mode.',
      'plan->verify': 'Switched from plan to verify mode.',
      'plan->code-review': 'Switched from plan to code review mode.',
      'explore->plan': 'Switched from explore to plan mode.',
      'explore->verify': 'Switched from explore to verify mode.',
      'explore->code-review': 'Switched from explore to code review mode.',
      'verify->plan': 'Switched from verify to plan mode.',
      'verify->explore': 'Switched from verify to explore mode.',
      'verify->code-review': 'Switched from verify to code review mode.',
      'code-review->plan': 'Switched from code review to plan mode.',
      'code-review->explore': 'Switched from code review to explore mode.',
      'code-review->verify': 'Switched from code review to verify mode.',
    }

    const key = `${previousMode}->${mode}`
    return transitions[key] || `Switched to ${mode} mode.${reasonText}`
  }

  getPrompt(): string {
    return getPrompt()
  }
}

// Export singleton instance
export const switchModeTool = new SwitchModeTool()

// Re-export constants for external use
export { ALL_MODES }
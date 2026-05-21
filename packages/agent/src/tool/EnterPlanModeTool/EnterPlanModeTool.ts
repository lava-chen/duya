/**
 * EnterPlanModeTool - Enter plan mode
 * Now delegates to SwitchModeTool for unified mode management
 */

import type { Tool, ToolResult } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import {
  setAgentMode,
  isReadOnlyMode,
} from '../SwitchModeTool/SwitchModeTool.js'

/**
 * Check if currently in plan mode
 */
export function isInPlanModeState(): boolean {
  return isReadOnlyMode()
}

/**
 * Set plan mode state
 */
export function setPlanModeState(state: boolean): void {
  setAgentMode(state ? 'plan' : 'general')
}

export class EnterPlanModeTool implements Tool, ToolExecutor {
  readonly name = ENTER_PLAN_MODE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(): Promise<ToolResult> {
    if (isInPlanModeState()) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          message: 'Already in plan mode',
          planMode: true,
        }),
      };
    }

    setAgentMode('plan');

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        message: 'Entered plan mode. Use Task tool with action "create" to plan your work.',
        planMode: true,
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const enterPlanModeTool = new EnterPlanModeTool();

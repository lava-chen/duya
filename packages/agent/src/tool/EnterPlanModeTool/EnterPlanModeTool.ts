/**
 * EnterPlanModeTool - Enter plan mode
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

// Plan mode state
let isInPlanMode = false;

/**
 * Check if currently in plan mode
 */
export function isInPlanModeState(): boolean {
  return isInPlanMode;
}

/**
 * Set plan mode state
 */
export function setPlanModeState(state: boolean): void {
  isInPlanMode = state;
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
    if (isInPlanMode) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          message: 'Already in plan mode',
          planMode: true,
        }),
      };
    }

    isInPlanMode = true;

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        message: 'Entered plan mode. Use TaskCreate to plan your work.',
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

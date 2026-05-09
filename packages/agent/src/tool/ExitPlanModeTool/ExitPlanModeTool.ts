/**
 * ExitPlanModeTool - Exit plan mode
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { EXIT_PLAN_MODE_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';
import { isInPlanModeState, setPlanModeState } from '../EnterPlanModeTool/EnterPlanModeTool.js';

export class ExitPlanModeTool implements Tool, ToolExecutor {
  readonly name = EXIT_PLAN_MODE_TOOL_NAME;
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
    if (!isInPlanModeState()) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          message: 'Not in plan mode',
          planMode: false,
        }),
      };
    }

    setPlanModeState(false);

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        message: 'Exited plan mode. Ready for implementation.',
        planMode: false,
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const exitPlanModeTool = new ExitPlanModeTool();

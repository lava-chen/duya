/**
 * ExitPlanModeTool - Exit plan mode
 * Now delegates to SwitchModeTool for unified mode management
 */

import type { Tool, ToolResult } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { isReadOnlyMode, setAgentMode } from '../SwitchModeTool/SwitchModeTool.js'
import { planModeTracker } from '../../modes/plan/plan-tracker.js'

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
    if (!isReadOnlyMode()) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          message: 'Not in plan mode',
          planMode: false,
        }),
      };
    }

    setAgentMode('general');
    // Sync the 413 PlanModeTracker so the runtime plan-file gate / reminders
    // release on tool exit (grok: exit_plan_mode drives the single tracker).
    // `exit_approved` is a no-op unless the tracker is active.
    planModeTracker.transition('exit_approved');

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

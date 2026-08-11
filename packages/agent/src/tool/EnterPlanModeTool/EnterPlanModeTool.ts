/**
 * EnterPlanModeTool - Enter plan mode
 * Now delegates to SwitchModeTool for unified mode management
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import {
  setAgentMode,
  isReadOnlyMode,
} from '../SwitchModeTool/SwitchModeTool.js'
import { planModeTracker } from '../../modes/plan/plan-tracker.js'
import { resolvePlanFilePath } from '../../modes/plan/plan-file-path.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'

/**
 * Plan-file seed status, mirroring grok `PlanFileSeedStatus`.
 */
export type PlanFileSeedStatus = 'empty' | 'non_empty' | 'missing'

/**
 * Probe the session plan file; create an empty one only on not-found
 * (grok `probe_or_create_empty_plan_file`). Never truncates existing
 * content. Non-NotFound read errors fail closed as `missing` without
 * writing.
 */
export async function probeOrCreateEmptyPlanFile(sessionId: string): Promise<PlanFileSeedStatus> {
  const planPath = resolvePlanFilePath(sessionId)
  try {
    const content = await readFile(planPath, 'utf-8')
    return content.length === 0 ? 'empty' : 'non_empty'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      try {
        await mkdir(dirname(planPath), { recursive: true })
        await writeFile(planPath, '', 'utf-8')
        return 'empty'
      } catch {
        return 'missing'
      }
    }
    // Directory-at-path or other read error: never write (avoid truncate risk).
    return 'missing'
  }
}

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

  async execute(
    _input: Record<string, unknown>,
    _workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const sessionId = context?.options.sessionId ?? 'default'
    const planPath = resolvePlanFilePath(sessionId)

    if (isInPlanModeState()) {
      // Grok seeds on every entry path; re-entry reports the existing file state.
      const seed = await probeOrCreateEmptyPlanFile(sessionId)
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          message: 'Already in plan mode',
          planMode: true,
          planFile: planPath,
          seed,
        }),
      };
    }

    setAgentMode('plan');
    // Sync the 413 PlanModeTracker so the runtime plan-file gate / reminders
    // follow the tool entry (grok: enter_plan_mode drives the single tracker).
    // `activate_from_tool` is a no-op unless the tracker is inactive.
    planModeTracker.transition('activate_from_tool');
    const seed = await probeOrCreateEmptyPlanFile(sessionId)

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        message: 'Entered plan mode. Use Task tool with action "create" to plan your work.',
        planMode: true,
        planFile: planPath,
        seed,
      }),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

// Export for use by other modules
export const enterPlanModeTool = new EnterPlanModeTool();

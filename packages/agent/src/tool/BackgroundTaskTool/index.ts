/**
 * Background task tools — read-only status snapshot + kill.
 *
 * Deliberately NO blocking wait tool (duya previously mirrored grok_build's
 * legacy `wait_tasks` / `get_task_output(timeout_ms>0)`; those were removed
 * because background tasks auto-deliver a terminal <task-notification> that
 * wakes the parent — a wait tool just invites dead polling).
 */

export {
  GetTaskOutputTool,
  getTaskOutputTool,
  GET_TASK_OUTPUT_TOOL_NAME,
  isTerminalStatus,
  formatTaskOutput,
  MAX_MULTI_TASK_IDS,
  DEFAULT_TOOL_OUTPUT_BYTES,
} from './GetTaskOutputTool.js';
export {
  KillTaskTool,
  killTaskTool,
  KILL_TASK_TOOL_NAME,
} from './KillTaskTool.js';

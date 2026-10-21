/**
 * PlanTool — unified plan management tool.
 *
 * Single tool with three actions (status / search / complete) for working
 * with execution plans stored under `~/.duya/projects/<projectId>/plans/`.
 */

export { PlanTool, planTool, PLAN_TOOL_NAME } from './PlanTool.js';
export { PlansError, PROJECT_ID_PATTERN, resolveProjectsRoot } from './storage.js';

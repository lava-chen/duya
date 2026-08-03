/**
 * Public entry point for `@duya/agent`.
 *
 * Runtime subsystems use direct module imports. This barrel intentionally
 * exposes only the agent constructor and the small type surface consumed by
 * the desktop renderer and library callers.
 */

export type {
  AgentOptions,
  ChatOptions,
  MCPConnectionStatus,
  MCPServerConfig,
  Message,
  SSEEvent,
  Tool,
  ToolUse,
} from './types.js';

export type {
  Task,
  TaskStatus,
} from './session/task-store.js';

export {
  CURATOR_SYSTEM_PROMPT,
  buildCuratorInitialMessage,
} from './memory-state/curation_prompt.js';
export type { RunInput } from './memory-state/curation_prompt.js';

export { duyaAgent, duyaAgent as default } from './agent/DuyaAgent.js';

import { DUYA_RESTART_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Restart the current agent session. Use this to apply configuration changes (like switching provider or model) or to recover from internal errors.

## When to use
- After modifying provider, model, or other settings via duya_config that require a restart
- When the agent encounters persistent errors and needs a fresh start
- User explicitly asks to restart

## Parameters
- **reason** (string) — Brief explanation of why the restart is needed
- **resume** (boolean) — Whether to send a completion message after restart (default: true)

## Behavior
- The current session will end and a new agent process will start
- Conversation context is preserved in the database
- If resume=true, the new agent will acknowledge the restart and continue`;

export function getPrompt(): string {
  return `Tool: ${DUYA_RESTART_TOOL_NAME} — Restart the agent session`;
}
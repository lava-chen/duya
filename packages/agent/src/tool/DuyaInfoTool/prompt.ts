import { DUYA_INFO_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Get information about your DUYA environment and current configuration. Use this to understand your capabilities, active providers, current model, and system status.

## When to use
- User asks about your current model, provider, or configuration
- You need to know what providers are available before configuring a new one
- User asks "what can you do?" or "what are you running on?"
- Before making config changes, check current state first`;

export function getPrompt(): string {
  return `Tool: ${DUYA_INFO_TOOL_NAME} — Get DUYA system information`;
}
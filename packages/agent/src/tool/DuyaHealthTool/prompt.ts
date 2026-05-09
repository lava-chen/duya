import { DUYA_HEALTH_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `Check DUYA system health: test provider connectivity and check gateway/platform connection status.

## Actions

### test_provider
Test whether the current (or specified) API provider is reachable. Use this when:
- The agent encounters API errors and needs to diagnose the issue
- User asks "is my API key working?"
- After adding a new provider, verify it connects

### gateway_status
Check the status of platform gateways (Telegram, WeChat, Discord, etc.). Shows which gateways are connected and active. Use this when:
- User asks about platform connectivity
- Debugging message delivery issues
- Checking if external channels are online`;

export function getPrompt(): string {
  return `Tool: ${DUYA_HEALTH_TOOL_NAME} — Health check and diagnostics`;
}
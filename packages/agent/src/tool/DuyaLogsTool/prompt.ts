import { DUYA_LOGS_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `View recent DUYA application logs for debugging and diagnostics.

## Actions

### tail
Get the most recent log entries. Use this to see what's happening in the system.

### errors
Get only ERROR and FATAL level log entries from recent logs. Use this when debugging failures.

## Parameters
- **lines** (number) — Number of lines/entries to return (default: 50, max: 100)

## When to use
- After a failed tool execution, check logs for root cause
- User reports unexpected behavior and you need diagnostic info
- Debugging provider connection issues
- Investigating performance or crash issues

Note: Logs may contain sensitive information like file paths or masked API keys. Review before sharing with the user.`;

export function getPrompt(): string {
  return `Tool: ${DUYA_LOGS_TOOL_NAME} — View application logs`;
}
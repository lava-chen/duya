import { DUYA_SESSIONS_TOOL_NAME } from './constants.js';

export const DESCRIPTION = `List and search your chat sessions.

## Actions

### list
List recent sessions with title, model, message count, and last update time. Use this when:
- User asks "what were we talking about before?"
- User wants to see conversation history
- You need to reference a previous conversation

### info
Get details about a specific session (title, model, provider, message count). Use this when:
- User asks about a specific session by title or topic

### search
Search across all sessions for specific keywords. Use this when:
- User says "find the conversation about X"
- User remembers discussing something but doesn't know which session`;

export function getPrompt(): string {
  return `Tool: ${DUYA_SESSIONS_TOOL_NAME} — Manage and search sessions`;
}
/**
 * turn-suggestion-client.ts - read the end-of-turn suggestion for a session.
 *
 * Two paths, one answer. A surface with a Host bridge (the Web) reads through
 * `UiServices`; the Desktop reads through its own IPC. A surface with neither
 * simply has no suggestion, which is the truth rather than a failure.
 */

import type { HostLocalTurnSuggestionRecord } from '@duya/agent-protocol/turn-suggestion';
import { peekUiServices } from '@/services';

export async function readLatestTurnSuggestion(
  sessionId: string,
): Promise<HostLocalTurnSuggestionRecord | null> {
  const services = peekUiServices();
  if (services?.turnSuggestions) {
    return await services.turnSuggestions.latest(sessionId);
  }
  const api = window.electronAPI?.turnSuggestions;
  if (!api) return null;
  const result = await api.latest(sessionId);
  return result.success ? result.suggestion : null;
}

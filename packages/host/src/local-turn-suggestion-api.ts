import type { HostLocalTurnSuggestionApiV1 } from '@duya/agent-protocol/turn-suggestion';
import type { ChatTurnSuggestionStore } from '@duya/data/chat-turn-suggestion-store';

export function createHostLocalTurnSuggestionApi(
  store: Pick<ChatTurnSuggestionStore, 'save' | 'getLatestForSession'>,
): HostLocalTurnSuggestionApiV1 {
  return {
    async saveTurnSuggestion(input) {
      store.save(input);
    },
    async getLatestTurnSuggestion(sessionId) {
      return store.getLatestForSession(sessionId);
    },
  };
}

import type { HostLocalTurnReviewApiV1 } from '@duya/agent-protocol/turn-review';
import type { ChatTurnReviewStore } from '@duya/data/chat-turn-review-store';

export function createHostLocalTurnReviewApi(
  store: Pick<
    ChatTurnReviewStore,
    'save' | 'getLatestForSession' | 'listForSession' | 'getById' | 'getBySessionAndTurnId'
  >,
): HostLocalTurnReviewApiV1 {
  return {
    async saveTurnReview(input) {
      store.save(input);
    },
    async getLatestTurnReview(sessionId) {
      return store.getLatestForSession(sessionId);
    },
    async listTurnReviewHistory(sessionId, limit) {
      return store.listForSession(sessionId, limit);
    },
    async getTurnReviewById(reviewId) {
      return store.getById(reviewId);
    },
    async getTurnReviewByTurnId(sessionId, turnId) {
      return store.getBySessionAndTurnId(sessionId, turnId);
    },
  };
}

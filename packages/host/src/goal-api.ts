import type { HostGoalApiV1 } from '@duya/agent-protocol/goals';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

/** Host-owned async boundary over the durable session-goal Data store. */
export function createHostGoalApi(stores: Pick<CoreDataHostStores, 'goals'>): HostGoalApiV1 {
  const goals = stores.goals;
  return {
    async getGoal(sessionId) {
      return goals.get(sessionId);
    },
    async getOrCreateGoal(input) {
      return goals.getOrCreate(input);
    },
    async updateBudget(sessionId, delta) {
      return goals.updateBudget(sessionId, delta);
    },
    async setStatus(sessionId, status) {
      return goals.setStatus(sessionId, status);
    },
    async listByStatus(status) {
      return goals.listByStatus(status);
    },
  };
}

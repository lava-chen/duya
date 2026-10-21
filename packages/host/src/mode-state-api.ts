import type {
  HostModeStateApiV1,
  ModeStateUpsertInput,
} from '@duya/agent-protocol/mode-state';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

/** Host-owned async boundary over the durable mode-state store. */
export function createHostModeStateApi(
  stores: Pick<CoreDataHostStores, 'modeState'>,
): HostModeStateApiV1 {
  const modeState = stores.modeState;
  return {
    async getModeState(sessionId, mode) {
      return modeState.get(sessionId, mode);
    },
    async upsertModeState(input: ModeStateUpsertInput) {
      modeState.upsert(
        input.sessionId,
        input.mode,
        input.status,
        input.snapshotJson,
        input.reminderCount,
      );
    },
    async setModeStateStatus(sessionId, mode, status) {
      modeState.setStatus(sessionId, mode, status);
    },
    async listModeStateBySession(sessionId) {
      return modeState.listBySession(sessionId);
    },
  };
}

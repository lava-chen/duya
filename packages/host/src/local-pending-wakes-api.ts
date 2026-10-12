import type {
  HostLocalPendingWakeApiV1,
  HostPendingWakeInput,
} from '@duya/agent-protocol';
import type { PendingWakeStore } from '@duya/data/pending-wakes';

/** Local Host projection over Data's durable pending-wake store. */
export function createHostLocalPendingWakeApi(wakes: PendingWakeStore): HostLocalPendingWakeApiV1 {
  return {
    async getPendingWake(kind, workId) {
      return wakes.get(kind, workId);
    },
    async persistPendingWake(input: HostPendingWakeInput) {
      wakes.persist(input);
    },
    async clearPendingWake(kind, workId) {
      return wakes.clear(kind, workId);
    },
    async listPendingWakes() {
      return wakes.listAll();
    },
    async pruneStalePendingWakes(beforeMs) {
      return wakes.pruneStale(beforeMs);
    },
  };
}

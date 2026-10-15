import type { HostLockApiV1, LockOrigin } from '@duya/agent-protocol';
import type { CoreDataHostStores } from '@duya/data/core-data-host';

/** Compose the async lock contract over the Host-owned runtime lock store. */
export function createHostLockApi(stores: Pick<CoreDataHostStores, 'locks'>): HostLockApiV1 {
  return {
    async acquireLock(input) {
      return stores.locks.acquire(
        input.sessionId,
        input.lockId,
        input.owner,
        input.ttlSec,
        input.origin,
      );
    },
    async renewLock(input) {
      return stores.locks.renew(input.sessionId, input.lockId, input.ttlSec);
    },
    async releaseLock(input) {
      return stores.locks.release(input.sessionId, input.lockId);
    },
    async isSessionLocked(sessionId) {
      return stores.locks.isLocked(sessionId);
    },
    async getSessionLockOrigin(sessionId): Promise<LockOrigin | null> {
      return stores.locks.lockOrigin(sessionId);
    },
  };
}

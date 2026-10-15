/** Source attribution for the run currently holding a session lock. */
export type LockOrigin = 'user' | 'agent' | 'background';

export interface HostLockAcquireInput {
  readonly sessionId: string;
  readonly lockId: string;
  readonly owner: string;
  readonly ttlSec?: number;
  readonly origin?: LockOrigin;
}

export interface HostLockRenewInput {
  readonly sessionId: string;
  readonly lockId: string;
  readonly ttlSec?: number;
}

export interface HostLockReleaseInput {
  readonly sessionId: string;
  readonly lockId: string;
}

/** Typed async boundary for the durable per-session runtime lock. */
export interface HostLockApiV1 {
  acquireLock(input: HostLockAcquireInput): Promise<boolean>;
  renewLock(input: HostLockRenewInput): Promise<boolean>;
  releaseLock(input: HostLockReleaseInput): Promise<boolean>;
  isSessionLocked(sessionId: string): Promise<boolean>;
  getSessionLockOrigin(sessionId: string): Promise<LockOrigin | null>;
}

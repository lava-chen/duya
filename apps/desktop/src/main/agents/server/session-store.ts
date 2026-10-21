import { WorkerSessionRegistry } from '@duya/host/worker-session-registry';
import { sessionLogger } from './logger';

/** Desktop Agent Server adapter for Host-owned worker session state. */
export class SessionManager extends WorkerSessionRegistry {
  constructor() {
    super(sessionLogger);
  }
}

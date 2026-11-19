import type {
  SessionSpawnOperation,
  SessionSpawnSession,
  SessionSpawnDetails,
  SessionToolPort,
} from '@duya/capabilities/session-tool';
import { sessionSpawnDb } from '../worker-db-client.js';

/** The calling Session, from the live tool context or the worker process. */
export function resolveCallerSessionId(contextSessionId?: string): string {
  return contextSessionId || process.env.SESSION_ID || 'unknown';
}

/** Bind the capability's session actions to the existing worker DB bridge. */
export function createWorkerSessionManagementPort(): SessionToolPort {
  return {
    getCallerSessionId(contextSessionId) {
      return resolveCallerSessionId(contextSessionId);
    },
    async spawn(input) {
      return await sessionSpawnDb.spawn(input) as SessionSpawnOperation<{ sessionId: string; parentId: string }>;
    },
    async list(parentSessionId) {
      return await sessionSpawnDb.list(parentSessionId) as SessionSpawnOperation<{ sessions: SessionSpawnSession[] }>;
    },
    async get(sessionId, callerSessionId) {
      return await sessionSpawnDb.get(sessionId, callerSessionId) as SessionSpawnOperation<{ session: SessionSpawnDetails }>;
    },
    async reply(input) {
      return await sessionSpawnDb.reply(input) as SessionSpawnOperation<{ sessionId: string }>;
    },
    async cancel(sessionId, callerSessionId) {
      return await sessionSpawnDb.cancel(sessionId, callerSessionId) as SessionSpawnOperation<{ sessionId: string }>;
    },
  };
}

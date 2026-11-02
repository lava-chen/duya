import type { CoreDataStores } from '@duya/data/core-stores';
import { createHostSessionService, type HostSessionServiceOptions } from '@duya/host/session-service';
import { createHostRunApi } from '@duya/host/run-api';
import { createDesktopRunExecutionApi } from './desktop-run-execution-api';

/** Compose the shared Session management domain with Desktop's existing executor. */
export function createDesktopSessionManagementService(options: {
  stores: Pick<CoreDataStores, 'sessions' | 'runs' | 'projects' | 'tasks'>;
  sessions: HostSessionServiceOptions['sessions'];
  checkoutService: HostSessionServiceOptions['checkoutService'];
  execution?: HostSessionServiceOptions['execution'];
}) {
  const { stores } = options;
  const runs = createHostRunApi(stores);
  return createHostSessionService({
    sessions: options.sessions,
    runs,
    ...(options.checkoutService ? { checkoutService: options.checkoutService } : {}),
    projectCoordination: { projects: stores.projects, tasks: stores.tasks },
    execution: options.execution ?? createDesktopRunExecutionApi({
      getSessionForRun: async (runId) => (await runs.getAgentRun(runId))?.sessionId ?? null,
    }),
    readLocalSession: async (id) => stores.sessions.get(id),
    validateCaller: (caller) => {
      const run = stores.runs.getRun(caller.runId);
      if (run?.session_id !== caller.sessionId || run.status !== 'running'
        || stores.runs.currentEpoch(caller.runId) !== caller.epoch) {
        throw new Error('caller_attempt_not_current');
      }
    },
  });
}

/**
 * The composition entry for the workspace-lifecycle namespaces (plan 621).
 *
 * ## Why this exists
 *
 * TWO Hosts serve the same routes: the headless `startLocalHost` and the
 * Desktop's embedded one. Assembling the checkout / integration APIs in both
 * places would give the two Hosts different answers to the same question —
 * and the Desktop's would quietly lack namespaces the headless one has. That
 * gap only shows up on one surface, which is the worst way for it to show up.
 *
 * So the assembly lives here, once, and both call it. The inputs are the two
 * facts the namespaces need — where a session works, and what its runs are —
 * and nothing else: the caller hands over readers, and gets back the three
 * APIs the HTTP server expects.
 *
 * ## The authority stays where it is
 *
 * The checkout's owner file and git's registry remain the authority for
 * ownership; the `runs` table remains the authority for aliveness (decision
 * D4 — no timestamps, no leases). This module only wires those facts to the
 * APIs; it never derives a fact of its own.
 */

import type { HostCheckoutApiV1, HostIntegrationApiV1 } from '@duya/agent-protocol';
import type { IntegrationStore } from '@duya/data';
import { createHostCheckoutApi } from './checkout-api.js';
import { createHostIntegrationApi } from './integration-api.js';
import { observePr as observeIntegrationPr } from './scm/index.js';
import { createIntegrationSync, type IntegrationSync } from './scm/sync.js';
import { createAlivenessInputs, cwdInsideRoot } from './workspace/aliveness.js';
import { createCheckoutProvider, gitOrNull, inspectRegistration } from './workspace/index.js';
import { canonicalPath } from './workspace/fs-utils.js';
import { hasBackgroundCheckoutLease } from './workspace/task-leases.js';

/** A session, as far as the workspace namespaces care. */
export interface WorkspaceLifecycleSession {
  readonly id: string;
  readonly workingDirectory: string;
}

/** The session facts the namespaces read. */
export interface WorkspaceLifecycleSessionSource {
  get(sessionId: string): WorkspaceLifecycleSession | null;
  list(): readonly WorkspaceLifecycleSession[];
}

/** The run facts the namespaces read. Only `status` matters (decision D4). */
export interface WorkspaceLifecycleRunSource {
  listRunsBySession(sessionId: string, limit?: number): Array<{ status: string }>;
}

export interface HostWorkspaceLifecycleApiOptions {
  readonly dataRoot?: string;
  readonly sessions: WorkspaceLifecycleSessionSource;
  readonly runs: WorkspaceLifecycleRunSource;
  readonly integrations: IntegrationStore;
}

/** The three APIs the Host's HTTP server takes for these namespaces. */
export interface HostWorkspaceLifecycleApis {
  readonly checkoutApi: HostCheckoutApiV1;
  readonly integrationApi: HostIntegrationApiV1;
  readonly integrationSync: IntegrationSync;
}

export function createHostWorkspaceLifecycleApis(
  options: HostWorkspaceLifecycleApiOptions,
): HostWorkspaceLifecycleApis {
  const { sessions, runs, integrations } = options;

  const checkoutApi = createHostCheckoutApi({
    // A's provider IS the observation port structurally, so the wiring is one
    // object literal — no adapter, no second implementation of §4.5.
    port: createCheckoutProvider({
      ...createAlivenessInputs({
        listRunsBySession: (sessionId, limit) => runs.listRunsBySession(sessionId, limit ?? 50),
        listRunningRunCwds: async () => {
          // A `running` run is by construction the session's NEWEST run, so
          // reading one row per session is enough to find every live run —
          // no cross-session query over the whole ledger.
          const cwds: string[] = [];
          for (const session of sessions.list()) {
            const newest = runs.listRunsBySession(session.id, 1)[0];
            if (newest?.status !== 'running') continue;
            if (session.workingDirectory === '') continue;
            cwds.push(session.workingDirectory);
          }
          return cwds;
        },
      }),
      cwdInUse: async (root) => hasBackgroundCheckoutLease(root, options.dataRoot) || sessions.list().some((session) =>
        runs.listRunsBySession(session.id, 1)[0]?.status === 'running' && cwdInsideRoot(root, session.workingDirectory)),
    }),
    resolveSessionCheckoutRoot: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session || session.workingDirectory === '') return null;
      const toplevel = await gitOrNull(session.workingDirectory, ['rev-parse', '--show-toplevel']);
      const trimmed = toplevel?.trim();
      if (!trimmed) return null;
      const root = canonicalPath(trimmed);
      const registration = await inspectRegistration(root);
      // A session in the user's OWN checkout resolves to null: it is not a
      // managed checkout, so there is nothing to own.
      return registration.registered ? root : null;
    },
  });

  // The observed PR/CI/review projection reads the same core handle as every
  // other store, and slice C's read-only `gh` observer is the one writer an
  // explicit refresh uses.
  const integrationApi = createHostIntegrationApi({ store: integrations, observePr: observeIntegrationPr });

  // The sync is the explicit "re-read GitHub now" act. It is separate from
  // the read API on purpose — reading the projection must never hit the
  // network, and the sync is the only writer of `observed_*` columns.
  const integrationSync = createIntegrationSync({
    store: integrations,
    getSessionWorkingDirectory: async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session || session.workingDirectory === '') return null;
      return session.workingDirectory;
    },
  });

  return { checkoutApi, integrationApi, integrationSync };
}

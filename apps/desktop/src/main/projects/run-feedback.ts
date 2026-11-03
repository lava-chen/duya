/**
 * run-feedback.ts — Desktop half of the project result loop.
 *
 * The Agent Server owns the Run and announces a durable terminal to Main.
 * Main owns the project ledger, the mailbox and the renderer fan-out, so the
 * settlement lives here: record the Run in `project_activity`, leave exactly
 * one durable notification for the Coordinator, and hand a NEW row to the same
 * two wake paths `mailbox:send` uses (renderer event + main idle dispatcher).
 *
 * Both wake paths already honour `wake.idleDispatch`, so exactly one fires.
 * The row itself is the recovery guarantee: if no surface is listening when
 * the terminal lands, the Coordinator's next turn claims the pending row.
 */

import {
  createProjectRunSettlementService,
  type ProjectRunSettlementService,
} from '@duya/host/project/reconciliation';
import { getCoreStores, type CoreStores } from '../db/core-connection';
import { coreMailboxToIpcRow } from '../ipc/core-db-adapters';
import { emitMailCreated } from '../messaging/mailbox-broadcaster';
import { maybeDispatchIdleWake } from '../wake/idle-dispatcher';
import { getLogger, LogComponent } from '../logging/logger';

interface BoundService {
  readonly stores: CoreStores;
  readonly service: ProjectRunSettlementService;
}

let bound: BoundService | null = null;

function serviceFor(stores: CoreStores): ProjectRunSettlementService {
  if (bound !== null && bound.stores === stores) return bound.service;
  const service = createProjectRunSettlementService({
    stores,
    wake: ({ mailboxItem }) => {
      const row = coreMailboxToIpcRow(mailboxItem);
      emitMailCreated(row);
      void maybeDispatchIdleWake({
        id: row.id as string,
        sessionId: row.session_id as string,
        kind: row.kind as string,
        content: row.content as string | undefined,
        clientMsgId: row.client_msg_id as string | null | undefined,
      }).catch(() => {});
    },
    logger: {
      warn: (message, fields) => {
        getLogger().warn(message, fields, LogComponent.Main);
      },
    },
  });
  bound = { stores, service };
  return service;
}

/** Record a settled Run and wake the owning Coordinator. Never throws. */
export function settleProjectRun(runId: string): void {
  try {
    serviceFor(getCoreStores()).settleRun(runId);
  } catch (error) {
    getLogger().error(
      'Project run settlement failed',
      error instanceof Error ? error : new Error(String(error)),
      { runId },
      LogComponent.Main,
    );
  }
}

/**
 * Recover terminal work-Session Runs whose notification never reached the
 * mailbox, such as a crash between the activity and mailbox writes. This runs
 * at boot; a row created before a renderer listener exists stays pending and
 * is claimed by the Coordinator's next turn.
 */
export function reconcileProjectRuns(): void {
  try {
    const result = serviceFor(getCoreStores()).reconcile();
    if (result.settled > 0) {
      getLogger().info('Reconciled project runs', result, LogComponent.Main);
    }
  } catch (error) {
    getLogger().error(
      'Project run reconciliation failed',
      error instanceof Error ? error : new Error(String(error)),
      undefined,
      LogComponent.Main,
    );
  }
}

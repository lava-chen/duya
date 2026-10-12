/**
 * worker-db-bridge.ts — the Host-side dispatcher for worker `db:request` frames.
 *
 * The worker never opens the application databases (plan 12's standing
 * invariant). In the Desktop topology its `db:request` frames are relayed to
 * Electron Main and served by `dispatchDbAction`. When the HOST owns
 * execution, the Host must serve them itself, from the same Host-owned stores
 * the HTTP APIs serve — this module is that dispatcher.
 *
 * Scope discipline: each action implemented here must be the SAME semantic the
 * Desktop bridge serves (same store, same shape), or it must fast-fail with a
 * typed error. A silent empty result would masquerade as "no data" and corrupt
 * a run; a fast failure is discovered in one round trip instead of a 30-second
 * worker timeout. Domains not yet migrated to Host ownership fail loudly here
 * until their typed Host service lands (plan 12 gate 1 continues domain by
 * domain).
 */

import { toolApprovalInputHash } from '@duya/data/tool-approval-state';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type {
  HostToolApprovalApiV1,
  HostToolApprovalInput,
  HostToolApprovalScopeType,
} from '@duya/agent-protocol';
import type { RunRepository } from './repository-port.js';
import { createRunControlPlaneActions, type RunControlPlaneLogger } from './run-control-plane.js';
import { createHostToolApprovalApi } from './tool-approval-api.js';
import type { WorkerDbBridge } from './run-execution.js';

export class WorkerDbBridgeError extends Error {
  constructor(
    readonly code: 'unimplemented_domain' | 'invalid_payload',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerDbBridgeError';
  }
}

export interface HostWorkerDbBridgeOptions {
  /** Durable run ledger — serves `run:*` exactly like the ledger API. */
  readonly runs: RunRepository;
  /** Session store — serves worker session reads. */
  readonly sessions: SessionStore;
  /** Legacy main-DB settings (worker reads via setting:*). */
  readonly settings: MainSettingsStore;
  /** Tool approval state in the legacy main DB. */
  readonly mainDatabase: MainDatabase;
  readonly logger?: RunControlPlaneLogger;
}

/**
 * The initial Host worker bridge: run ledger, session reads, settings, and the
 * tool-approval domain. Everything else rejects with
 * `WorkerDbBridgeError('unimplemented_domain')` naming the action, so a run
 * that needs an unmigrated domain fails fast and names it.
 */
export function createHostWorkerDbBridge(options: HostWorkerDbBridgeOptions): WorkerDbBridge {
  const controlPlane = createRunControlPlaneActions({
    runs: options.runs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const toolApprovals = (): HostToolApprovalApiV1 => createHostToolApprovalApi(options.mainDatabase.db);

  return {
    async dispatch(action: string, payload: Record<string, unknown>): Promise<unknown> {
      const handled = await controlPlane.dispatchControlPlaneAction(action, payload);
      if (handled !== undefined) return handled;

      switch (action) {
        // ==================== Sessions (reads only for now) ====================
        case 'session:get': {
          const id = payload.id;
          if (typeof id !== 'string' || id === '') {
            throw new WorkerDbBridgeError('invalid_payload', 'session:get requires id');
          }
          return options.sessions.get(id);
        }
        case 'session:list': {
          return options.sessions.list();
        }

        // ==================== Settings ====================
        case 'setting:get': {
          const key = payload.key;
          if (typeof key !== 'string') {
            throw new WorkerDbBridgeError('invalid_payload', 'setting:get requires key');
          }
          return options.settings.getString(key);
        }
        case 'setting:getAll': {
          return options.settings.getAllStrings();
        }
        case 'setting:getJson': {
          const key = payload.key;
          const fallback = payload.defaultValue;
          if (typeof key !== 'string') {
            throw new WorkerDbBridgeError('invalid_payload', 'setting:getJson requires key');
          }
          const raw = options.settings.getString(key);
          if (raw === null) return fallback;
          try {
            return JSON.parse(raw);
          } catch {
            return fallback;
          }
        }

        // ==================== Tool approvals ====================
        case 'toolApproval:create': {
          return toolApprovals().createToolApproval({
            id: payload.id as string,
            messageId: payload.messageId as string,
            sessionId: payload.sessionId as string,
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId: payload.scopeId as string,
            toolName: payload.toolName as string,
            ...(payload.toolInput === undefined
              ? {}
              : { toolInput: payload.toolInput as Record<string, unknown> }),
          } satisfies HostToolApprovalInput);
        }
        case 'toolApproval:consumeApproved': {
          return toolApprovals().consumeApprovedToolApproval({
            sessionId: payload.sessionId as string,
            toolName: payload.toolName as string,
            inputHash: toolApprovalInputHash(payload.toolInput as Record<string, unknown> | undefined),
          });
        }
        case 'toolApproval:listRules': {
          return toolApprovals().listToolApprovalRules({
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId: payload.scopeId as string,
          });
        }
        case 'toolApproval:upsertRule': {
          const scopeId = payload.scopeId as string;
          const toolName = payload.toolName as string;
          if (scopeId === '' || toolName === '') {
            throw new WorkerDbBridgeError('invalid_payload', 'toolApproval:upsertRule requires scopeId and toolName');
          }
          await toolApprovals().upsertToolApprovalRule({
            scopeType: (payload.scopeType as HostToolApprovalScopeType) ?? 'session',
            scopeId,
            toolName,
          });
          return { ok: true };
        }
        default:
          throw new WorkerDbBridgeError(
            'unimplemented_domain',
            `worker db action '${action}' has no Host implementation yet ` +
              '(plan 12 gate 1: migrate this domain to a typed Host service, then add it here)',
          );
      }
    },
  };
}


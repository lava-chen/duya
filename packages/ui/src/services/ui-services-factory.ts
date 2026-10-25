/**
 * The one composition of a `HostApiBridge` into a `UiServices`.
 *
 * ## Why this lives here
 *
 * The Web surface and the Desktop surface both need the same thing: a way to
 * hand the shared renderer a `UiServices` that talks to a Host. The only
 * things that differ are WHICH Host and WHAT the surface can do — the
 * plumbing between them is identical, and if each surface wrote its own, the
 * two would drift in exactly the places that are hard to see: a run list that
 * filters differently, a cancellation that swallows a refusal, an approval
 * that resolves against a different id space.
 *
 * So the plumbing is written once, here, and a surface supplies a bridge, a
 * platform tag and its capability report.
 *
 * ## What it deliberately does NOT do
 *
 * It does not decide anything. The Host owns sessions, runs, approvals and
 * their durable ledgers. Every method below returns what the Host returned or
 * throws the Host's refusal. A run record is projected onto the fields the
 * renderer needs and NOTHING else — no field is defaulted, no status is
 * inferred, no missing value is filled in with a guess.
 */

import type {
  AgentRunRecord,
  CancelAgentRunResult,
  HostMessagePage,
  HostMessageReadAllQuery,
  HostMessageReadQuery,
  HostPermissionRequest,
  HostPermissionRequestResolveInput,
  HostProviderCatalog,
  HostSessionCreateInput,
  HostSessionDeleteResult,
  HostSessionListQuery,
  HostSessionPage,
  HostSessionPatch,
  HostSessionRecord,
  HostSessionUpdateResult,
  RunId,
  SessionId,
  StartAgentRunResult,
} from '@duya/agent-protocol';
import type { HostLocalTurnSuggestionRecord } from '@duya/agent-protocol/turn-suggestion';
import type { HostApiBridge } from '@duya/client-core';
import { createRunProjection } from '@duya/client-core';
import type { UiPlatformCapabilities, UiRunRecord, UiServices, UiStartRunInput } from './ui-services.js';

export interface CreateUiServicesOptions {
  readonly bridge: HostApiBridge;
  readonly platform: UiServices['platform'];
  readonly capabilities: UiPlatformCapabilities;
  /** Ledger poll cadence for a run projection, in milliseconds. */
  readonly ledgerPollIntervalMs?: number;
}

/**
 * Project a Host run row onto the fields the shared renderer needs.
 *
 * `AgentRunRecord.status` and `UiRunRecord['status']` are the same union
 * today. The mapping is written out rather than spread, so that a future
 * status on one side and not the other becomes a type error here instead of
 * an `undefined` in the UI.
 */
function toUiRunRecord(record: AgentRunRecord): UiRunRecord {
  return {
    runId: record.runId,
    sessionId: record.sessionId,
    status: record.status,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

/** Build a `UiServices` from a Host bridge. */
export function createUiServices(options: CreateUiServicesOptions): UiServices {
  const bridge = options.bridge;
  return {
    platform: options.platform,
    capabilities: options.capabilities,
    sessions: {
      list: (query?: HostSessionListQuery): Promise<HostSessionPage> => bridge.listSessions(query),
      get: (sessionId: SessionId): Promise<HostSessionRecord | null> => bridge.getSession(sessionId),
      create: (input: HostSessionCreateInput): Promise<HostSessionRecord> => bridge.createSession(input),
      update: (
        sessionId: SessionId,
        expectedUpdatedAt: number | undefined,
        patch: HostSessionPatch,
      ): Promise<HostSessionUpdateResult> => bridge.updateSession(sessionId, expectedUpdatedAt, patch),
      delete: (sessionId: SessionId, expectedUpdatedAt?: number): Promise<HostSessionDeleteResult> =>
        bridge.deleteSession(sessionId, expectedUpdatedAt),
      readMessages: (sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage> =>
        bridge.readMessages(sessionId, query),
      readAllMessages: (sessionId: SessionId, query?: HostMessageReadAllQuery): Promise<HostMessagePage> =>
        bridge.readAllMessages(sessionId, query),
    },
    runs: {
      listBySession: async (
        sessionId: SessionId,
        limit?: number,
        signal?: AbortSignal,
      ): Promise<readonly UiRunRecord[]> => {
        // A selection that was abandoned must not deliver a stale list into
        // the next one. The abort is checked before AND after the read, so a
        // response that lands after the switch is dropped rather than
        // overwriting the new selection's run.
        //
        // The check lives in a function on purpose: after an early `return`,
        // control-flow analysis has already narrowed `signal?.aborted` to
        // `false | undefined`, and a second inline `=== true` would then be a
        // comparison TypeScript can prove is impossible. The abort is a
        // RUNTIME fact about a signal that changes under us, not a type-level
        // one, so the second check has to be able to observe the change.
        const abandoned = (): boolean => signal?.aborted === true;
        if (abandoned()) return [];
        const records = await bridge.listRuns(sessionId, limit);
        if (abandoned()) return [];
        return records.map(toUiRunRecord);
      },
      start: (input: UiStartRunInput): Promise<StartAgentRunResult> => bridge.startRun(input),
      cancel: (runId: string, reason?: string): Promise<CancelAgentRunResult> =>
        bridge.cancelRun(runId as RunId, reason),
      openSession: (runId: RunId, sessionId: SessionId, signal: AbortSignal) =>
        createRunProjection({
          bridge,
          runId,
          sessionId,
          signal,
          ...(options.ledgerPollIntervalMs === undefined
            ? {}
            : { ledgerPollIntervalMs: options.ledgerPollIntervalMs }),
        }),
    },
    approvals: {
      listPending: (sessionId?: SessionId): Promise<readonly HostPermissionRequest[]> =>
        bridge.listPendingApprovals(sessionId),
      resolve: (
        requestId: string,
        input: HostPermissionRequestResolveInput,
      ): Promise<HostPermissionRequest | null> => bridge.resolveApproval(requestId, input),
    },
    // The provider roster is present only when the bridge can read one. A
    // bridge that cannot leaves the namespace out, and the model picker then
    // has nothing to show -- which is the truth, rather than a list the
    // surface made up.
    ...(bridge.getProviderCatalog === undefined
      ? {}
      : { providers: { catalog: (): Promise<HostProviderCatalog | null> => bridge.getProviderCatalog!() } }),
    // The end-of-turn suggestion is present only when the bridge can read one.
    // A bridge that cannot leaves the namespace out, and the composer keeps
    // its ordinary placeholder.
    ...(bridge.getLatestTurnSuggestion === undefined
      ? {}
      : {
          turnSuggestions: {
            latest: (sessionId: SessionId): Promise<HostLocalTurnSuggestionRecord | null> =>
              bridge.getLatestTurnSuggestion!(sessionId),
          },
        }),
  };
}

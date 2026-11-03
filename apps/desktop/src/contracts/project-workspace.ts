// Shared IPC contract for the Project-first workspace surface.
//
// The renderer cannot reach the Host directly: it asks the main process over
// IPC, and the main process asks the Host. This file is the vocabulary of
// that narrow surface, consumed by the preload bridge, the main-process
// handlers, and — through the `ElectronAPI` type — the renderer.
//
// The payload shapes are NOT re-declared here. The project state and the
// control lease are the Host's own wire contracts, imported from
// `@duya/agent-protocol`, so the Desktop cannot drift from the Host: a task
// status is the task store's status, and a lease is the lease the Host
// granted.

import type {
  HostProjectState,
  SessionControlLease,
} from '@duya/agent-protocol';

/**
 * Every channel answers with the same envelope.
 *
 * `success: false` means the call did not happen — a transport failure, a
 * missing project, a malformed argument. It is NOT how the Host reports "you
 * may not have that": a refused takeover is a successful call whose answer
 * says there is no lease.
 */
export interface ProjectWorkspaceError {
  readonly success: false;
  readonly error: string;
}

/** The unified project state, as the Host observed it. */
export type ProjectWorkspaceStateResult =
  | { readonly success: true; readonly state: HostProjectState | null }
  | ProjectWorkspaceError;

/**
 * The project's coordinator conversation.
 *
 * `created` says whether this call made it. The session itself is durable and
 * belongs to the project, not to the call that found it: replacing it later
 * does not change the project's identity.
 */
export type ProjectWorkspaceCoordinatorResult =
  | { readonly success: true; readonly sessionId: string; readonly created: boolean }
  | ProjectWorkspaceError;

/**
 * The control lease over one session.
 *
 * A `null` lease is an ordinary answer: nobody holds the session, or somebody
 * else does and this call was refused. The caller can tell those apart by
 * asking again — which is the point of a read.
 */
export type ProjectWorkspaceLeaseResult =
  | { readonly success: true; readonly lease: SessionControlLease | null }
  | ProjectWorkspaceError;

/** Giving the lease back. `released: false` means it was already gone. */
export type ProjectWorkspaceReleaseResult =
  | { readonly success: true; readonly released: boolean }
  | ProjectWorkspaceError;

/**
 * The live state of the project's working sessions.
 *
 * The session row says a session EXISTS; only the Agent Server knows whether
 * it is running right now. A session missing from the map is one the Agent
 * Server has never seen — which is a fact, and not the same as "idle".
 */
export type ProjectWorkspaceStatusResult =
  | { readonly success: true; readonly statuses: Readonly<Record<string, string>> }
  | ProjectWorkspaceError;

/** The whole Project-first surface on the Electron bridge. */
export interface ProjectWorkspaceAPI {
  /**
   * The whole project state in one read: the project, its coordinator
   * conversation, its tasks and its working sessions.
   */
  readonly state: (projectId: string) => Promise<ProjectWorkspaceStateResult>;
  /**
   * The project's coordinator conversation, created on first use.
   *
   * Idempotent: the second call returns the same session and says
   * `created: false`.
   */
  readonly ensureCoordinator: (projectId: string) => Promise<ProjectWorkspaceCoordinatorResult>;
  /**
   * The live state of the given working sessions, as the Agent Server reports
   * it. A session that is not in the map is one the Agent Server has never
   * seen.
   */
  readonly workSessionStatus: (
    sessionIds: readonly string[],
  ) => Promise<ProjectWorkspaceStatusResult>;
  /** The per-session control lease: who may direct that session right now. */
  readonly lease: {
    readonly get: (sessionId: string) => Promise<ProjectWorkspaceLeaseResult>;
    /** Take the session over. A `null` lease means somebody else holds it. */
    readonly acquire: (
      sessionId: string,
      requestId: string,
      ttlMs?: number,
    ) => Promise<ProjectWorkspaceLeaseResult>;
    /** Give it back. The holder must present the revision it was given. */
    readonly release: (sessionId: string, revision: number) => Promise<ProjectWorkspaceReleaseResult>;
  };
}

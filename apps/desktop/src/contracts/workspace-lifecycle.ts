// Shared IPC contract for the workspace-lifecycle bridge (plan 621, slice F).
//
// The renderer cannot reach the Host directly: it asks the main process over
// IPC, and the main process asks the Host. This file is the single source of
// truth for that narrow surface, consumed by the preload bridge, the
// main-process handlers, and — through the `ElectronAPI` type — the renderer.
//
// The payload shapes are NOT re-declared here. They are the Host's own wire
// contract, imported from `@duya/agent-protocol`, so the Desktop cannot drift
// from the Host: an `unknown` integration observation stays `unknown`, and a
// reclaim refusal stays a refusal rather than becoming an error.

import type {
  HostCheckoutObserved,
  HostCheckoutRetainReason,
  HostIntegrationRecord,
  HostIntegrationSyncResult,
  HostSessionCheckoutView,
} from '@duya/agent-protocol';

/**
 * The reclaim answer.
 *
 * `removed: false` is a NORMAL result, not an error: it is the Host's answer
 * to "may this be deleted", nothing was deleted, and the reason names the one
 * condition that refused. Only a transport or I/O failure is an error.
 */
export type WorkspaceLifecycleReclaimResult =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: HostCheckoutRetainReason };

/** The checkout half of the bridge: observation and the one delete request. */
export interface WorkspaceLifecycleCheckoutAPI {
  control?: (sessionId: string, command: import('@duya/agent-protocol').SessionCheckoutCommand) => Promise<import('@duya/agent-protocol').SessionCheckoutResult>;
  /** The checkout the session sits in, and whether it owns it. */
  observeForSession: (sessionId: string) => Promise<HostSessionCheckoutView>;
  /** One checkout by root path. */
  observeCheckout: (root: string) => Promise<HostCheckoutObserved>;
  /** Ask the Host to remove one checkout. A refusal is a normal answer. */
  requestReclaim: (root: string) => Promise<WorkspaceLifecycleReclaimResult>;
}

/** The integration half of the bridge: the observed PR projection. */
export interface WorkspaceLifecycleIntegrationAPI {
  /** Every integration observed for a session, across all its PRs. */
  observeForSession: (sessionId: string) => Promise<readonly HostIntegrationRecord[]>;
  /**
   * Re-read the session's PRs from the hosting service.
   *
   * This is the explicit refresh. Reading the projection above never touches
   * the network, so without this the projection only ever gets older.
   */
  refreshForSession: (sessionId: string) => Promise<HostIntegrationSyncResult>;
}

/** The whole workspace-lifecycle surface on the Electron bridge. */
export interface WorkspaceLifecycleAPI {
  readonly checkouts: WorkspaceLifecycleCheckoutAPI;
  readonly integrations: WorkspaceLifecycleIntegrationAPI;
}

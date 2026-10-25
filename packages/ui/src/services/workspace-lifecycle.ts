/**
 * The workspace-lifecycle port: what a surface needs to answer the
 * checkout / integration questions (plan 621, slice F).
 *
 * ## Why this is a separate port and not part of `UiServices`
 *
 * `UiServices` is the seam the shared renderer already uses, and it is the
 * seam the WEB surface is wired to. The DESKTOP surface is not: it still
 * reaches the Host through `window.electronAPI` and the `ipc-client` wrappers,
 * and wiring that onto `UiServices` is explicitly deferred to a separate
 * task (see `docs/exec-plans/active/610-architecture-series/24-shared-renderer.md`).
 *
 * Plan 621 needs BOTH surfaces to answer the checkout / integration questions,
 * and it must not widen into that deferred migration. So this is a second,
 * deliberately narrow port: only the two namespaces plan 621 introduces, with
 * its own registry in the shape of `configureUiServices`. A surface installs
 * one adapter; the shared panel reads through this port and never learns which
 * transport answered.
 *
 * ## The two namespaces are OBSERVATIONS, and the port keeps them that way
 *
 * Everything here is a point-in-time read of the Host's authority. A client
 * that caches `reclaimable: true` and acts on it later is using an observation
 * as a decision — the exact thing the contract (§4.3) forbids. So:
 *
 *   - `observeCheckout` / `observeForSession` answer "what is true now";
 *   - `requestReclaim` is the ONLY way to delete, and it asks the Host to
 *     re-evaluate every §4.5 condition at the moment of the action.
 *
 * A surface MUST NOT turn an observed verdict into a local decision. The
 * `requestReclaim` method exists so that there is no other way to phrase the
 * request.
 *
 * ## `unknown` is a real state
 *
 * An integration observation can fail (no `gh`, no network, no token). The
 * Host reports `state: 'unknown'` with the reason, and the contract requires
 * that this never be folded into `'open'`. A surface renders the reason
 * instead of pretending the PR is open.
 */

import type {
  HostCheckoutObserved,
  HostCheckoutRetainReason,
  HostIntegrationRecord,
  HostIntegrationSyncResult,
  HostSessionCheckoutView,
  SessionId,
} from '@duya/agent-protocol';

/**
 * What one surface must be able to ask the Host about checkouts and
 * integrations.
 *
 * Every method is a Host call. None of them is implemented by the surface:
 * a surface that cannot reach a namespace leaves it out entirely (the
 * namespace is OPTIONAL below), and the panel then says the surface cannot
 * answer — which is the truth, rather than a panel that shows an empty
 * checkout the user then acts on.
 */
export interface WorkspaceLifecyclePort {
  readonly checkouts: {
    control?: (sessionId: string, command: import('@duya/agent-protocol').SessionCheckoutCommand) => Promise<import('@duya/agent-protocol').SessionCheckoutResult>;
    /** The checkout the given session sits in, and whether it may write there. */
    observeForSession(sessionId: SessionId): Promise<HostSessionCheckoutView>;
    /** One checkout by root path. */
    observeCheckout(root: string): Promise<HostCheckoutObserved>;
    /**
     * Ask the Host to remove one checkout.
     *
     * A refusal is a NORMAL result, not an error: `{ removed: false, reason }`
     * is the answer to "may this be deleted", and nothing was deleted. Only a
     * transport or I/O failure rejects.
     */
    requestReclaim(
      root: string,
    ): Promise<{ readonly removed: true } | { readonly removed: false; readonly reason: HostCheckoutRetainReason }>;
  };
  readonly integrations: {
    /** Every integration associated with a session, across all its PRs. */
    observeForSession(sessionId: SessionId): Promise<readonly HostIntegrationRecord[]>;
    /**
     * Re-read the session's pull requests from the hosting service.
     *
     * This is the explicit refresh. The projection read above never touches
     * the network, so without this the projection only ever gets older.
     *
     * It is session-scoped because that is the Host's write side: one pass
     * walks session → cwd → origin → checkpoint refs → PRs and lands every
     * observation it managed to read. A PR that could not be read is reported
     * in `failed`, and the previous good observation is kept — a failed pass
     * never overwrites what it did not manage to observe.
     */
    refreshForSession(sessionId: SessionId): Promise<HostIntegrationSyncResult>;
  };
}

/**
 * The OPTIONAL half of the port.
 *
 * A surface that cannot reach the Host's checkout namespace (a browser with
 * no local filesystem, a Host composed without A's provider) leaves
 * `checkouts` out. The panel then renders "this surface cannot answer",
 * which is a different answer from "this session has no checkout" — the same
 * distinction the Host's own routes make with a named 404.
 */
export interface PartialWorkspaceLifecyclePort {
  readonly checkouts?: WorkspaceLifecyclePort['checkouts'];
  readonly integrations?: WorkspaceLifecyclePort['integrations'];
}

let configuredPort: PartialWorkspaceLifecyclePort | null = null;

/** Install the surface-specific adapter before mounting the shared renderer. */
export function configureWorkspaceLifecycle(port: PartialWorkspaceLifecyclePort): void {
  configuredPort = port;
}

/** Clear only the adapter that was installed by the caller. */
export function clearWorkspaceLifecycle(port: PartialWorkspaceLifecyclePort): void {
  if (configuredPort === port) configuredPort = null;
}

/**
 * Access for existing non-React code.
 *
 * Throws when no adapter was installed, because a caller that reaches for the
 * port without one has a wiring bug — not a state the UI should render.
 */
export function getWorkspaceLifecycle(): PartialWorkspaceLifecyclePort {
  if (configuredPort === null) {
    throw new Error('Workspace lifecycle services have not been configured for this renderer');
  }
  return configuredPort;
}

/** Non-throwing access, for a surface that may or may not have installed one. */
export function peekWorkspaceLifecycle(): PartialWorkspaceLifecyclePort | null {
  return configuredPort;
}

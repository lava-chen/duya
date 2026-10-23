/**
 * workspace-lifecycle-ipc.ts — the renderer's window onto the Host's
 * checkout and integration observations (plan 621, slice F).
 *
 * ## The bridge may be absent, and that is an answer
 *
 * The shared renderer runs on a host it did not choose: Electron provides
 * `window.electronAPI`, the browser does not. A surface with no bridge
 * cannot answer the checkout questions, and the port contract says so in one
 * specific way: it leaves the namespace out, and the panel renders "this
 * surface cannot answer".
 *
 * That is NOT the same fact as "this session has no checkout", so the
 * wrappers below answer `null` — never a fabricated empty observation — when
 * the bridge is missing. A missing bridge must not take the whole load down
 * either, which is why every wrapper answers instead of throwing.
 *
 * ## Nothing here decides anything
 *
 * The answers are the Host's own DTOs, passed through verbatim. An
 * integration observation that says `unknown` stays `unknown`; a reclaim that
 * says `removed: false` stays a refusal, because it is the Host's verdict on
 * "may this be deleted" and nothing was deleted.
 */

import type {
  HostCheckoutObserved,
  HostIntegrationRecord,
  HostIntegrationSyncResult,
  HostSessionCheckoutView,
  SessionId,
} from '@duya/agent-protocol';
import type { PartialWorkspaceLifecyclePort, WorkspaceLifecyclePort } from '@/services/workspace-lifecycle';

type ElectronBridge = NonNullable<typeof window.electronAPI>;
type WorkspaceLifecycleBridge = ElectronBridge['workspaceLifecycle'];

/** The reclaim verdict, taken from the port contract rather than restated. */
type ReclaimMethod = WorkspaceLifecyclePort['checkouts']['requestReclaim'];
export type WorkspaceLifecycleReclaimResult = Awaited<ReturnType<ReclaimMethod>>;

/**
 * The bridge, or nothing.
 *
 * `window.electronAPI` is typed as always present, but the renderer also
 * runs in a browser, where it is not. Reading it through this function keeps
 * that difference in one place instead of in every call site.
 */
function bridge(): WorkspaceLifecycleBridge | undefined {
  return window.electronAPI?.workspaceLifecycle;
}

/** The checkout the session sits in, or null when this surface cannot answer. */
export async function observeCheckoutForSession(
  sessionId: SessionId,
): Promise<HostSessionCheckoutView | null> {
  const api = bridge();
  if (!api) return null;
  return await api.checkouts.observeForSession(sessionId);
}

/** One checkout by root path, or null when this surface cannot answer. */
export async function observeCheckout(root: string): Promise<HostCheckoutObserved | null> {
  const api = bridge();
  if (!api) return null;
  return await api.checkouts.observeCheckout(root);
}

/**
 * Ask the Host to remove one checkout.
 *
 * A refusal (`removed: false`) is a normal result and is returned as it is.
 * Null means this surface cannot answer at all.
 */
export async function requestCheckoutReclaim(
  root: string,
): Promise<WorkspaceLifecycleReclaimResult | null> {
  const api = bridge();
  if (!api) return null;
  return await api.checkouts.requestReclaim(root);
}

/** Every integration observed for a session, or null when this surface cannot answer. */
export async function observeIntegrationsForSession(
  sessionId: SessionId,
): Promise<readonly HostIntegrationRecord[] | null> {
  const api = bridge();
  if (!api) return null;
  return await api.integrations.observeForSession(sessionId);
}

/**
 * Re-read the session's PRs, or null when this surface cannot answer.
 *
 * This is the explicit refresh: reading the projection above never touches
 * the network, so without this the projection only ever gets older.
 */
export async function refreshIntegrationsForSession(
  sessionId: SessionId,
): Promise<HostIntegrationSyncResult | null> {
  const api = bridge();
  if (!api) return null;
  return await api.integrations.refreshForSession(sessionId);
}

/**
 * The Desktop's adapter for the workspace-lifecycle port.
 *
 * A surface with no bridge installs NO namespace, which is how the port
 * contract says "this surface cannot answer". A surface with the bridge
 * installs both, and the panel then reads the Host's answers.
 */
export function createElectronWorkspaceLifecyclePort(): PartialWorkspaceLifecyclePort {
  const api = bridge();
  if (!api) return {};
  return {
    checkouts: {
      observeForSession: (sessionId) => api.checkouts.observeForSession(sessionId),
      observeCheckout: (root) => api.checkouts.observeCheckout(root),
      requestReclaim: (root) => api.checkouts.requestReclaim(root),
    },
    integrations: {
      observeForSession: (sessionId) => api.integrations.observeForSession(sessionId),
      refreshForSession: (sessionId) => api.integrations.refreshForSession(sessionId),
    },
  };
}

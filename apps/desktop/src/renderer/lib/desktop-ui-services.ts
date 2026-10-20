/**
 * The Desktop's `UiServices` adapter.
 *
 * ## What this is
 *
 * `packages/ui` renders a chat against an `UiServices` port. The Web surface
 * fills that port with a same-origin BFF; the Desktop fills it with whatever
 * the Main process can reach. This file is the Desktop's filling of it, and
 * it is deliberately thin: it names the Desktop's Host endpoint and reports
 * the Desktop's capabilities, and everything else is the shared composition in
 * `packages/ui`. An adapter that "helpfully" patched a missing field would be
 * a second source of truth, and the Host's ledger guarantees would stop being
 * the thing the user sees.
 *
 * ## Why the endpoint is a parameter
 *
 * The Desktop's Host listens on a random port behind a random bearer token
 * (`apps/desktop/src/main/cli/desktop-host-api.ts` writes both to
 * `<dataRoot>/runtime/host-api.json`). The renderer cannot learn them on its
 * own: the Host's HTTP server refuses any request carrying an `Origin` header
 * (`origin_not_allowed` — a CSRF defence), and a browser `fetch` from a
 * `file://` page always carries one.
 *
 * So the endpoint arrives from the Main process. Until that bridge exists,
 * this adapter is complete but not installed — and the production entry point
 * stays on the legacy path, because running both would put two arbiters in
 * charge of one run.
 */

import {
  createHostHttpBridge,
  createUiServices,
  type HostFetchLike,
  type UiPlatformCapabilities,
  type UiServices,
} from '@duya/ui/services';

/** Where the Desktop's Host is listening, and the credential it demands. */
export interface DesktopHostEndpoint {
  /** Origin of the Host HTTP API, e.g. `http://127.0.0.1:53124`. */
  readonly origin: string;
  /** Bearer token the Host's HTTP server demands. */
  readonly token: string;
}

export interface DesktopUiServicesOptions {
  readonly endpoint: DesktopHostEndpoint;
  /** Injected so a test can supply its own transport. */
  readonly fetchImpl?: HostFetchLike;
  /**
   * Overrides for the platform capability report.
   *
   * The Desktop really does have all of these; the override exists so a test
   * (or a future Desktop build without one of them) can say so honestly
   * instead of the adapter claiming a capability the surface does not have.
   */
  readonly capabilities?: Partial<UiPlatformCapabilities>;
  /** Ledger poll cadence for a run projection. */
  readonly ledgerPollIntervalMs?: number;
}

/**
 * Everything the Desktop renderer can do today.
 *
 * The report is the Desktop's own: it has the filesystem, settings,
 * extensions, the conductor canvas, bots, automations and workflows. It is
 * reported per surface so the shared renderer can hide what a surface cannot
 * honour, rather than rendering a button that silently does nothing.
 */
const DESKTOP_CAPABILITIES: UiPlatformCapabilities = {
  localFileAccess: true,
  settings: true,
  extensions: true,
  conductor: true,
  bots: true,
  automation: true,
  workflows: true,
};

/**
 * Build the Desktop's `UiServices`.
 *
 * The bridge is created eagerly so a misconfigured endpoint fails at
 * installation time, where it is visible, rather than on the first user
 * message, where it is not.
 */
export function createDesktopUiServices(options: DesktopUiServicesOptions): UiServices {
  const bridge = createHostHttpBridge({
    origin: options.endpoint.origin,
    token: options.endpoint.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return createUiServices({
    bridge,
    platform: 'desktop',
    capabilities: { ...DESKTOP_CAPABILITIES, ...options.capabilities },
    ...(options.ledgerPollIntervalMs === undefined
      ? {}
      : { ledgerPollIntervalMs: options.ledgerPollIntervalMs }),
  });
}

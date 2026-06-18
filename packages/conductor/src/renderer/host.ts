/**
 * ConductorHost — host injection contract for the renderer module.
 *
 * The renderer module is self-contained: it does not import from
 * `src/lib/*` or any other frontend path. Anything it needs from
 * the host application is declared here as a typed interface and
 * provided at runtime via `<ConductorHostProvider host={...}>`.
 *
 * Today the host supplies two capabilities:
 *
 *   1. `listProviders()` — for the model selector in the conductor
 *      composer. Replaces the old direct import of `listProvidersIPC`
 *      from `src/lib/ipc-client`.
 *
 *   2. `agent.callRefine(...)` — for the side-panel refine agent.
 *      Replaces the old direct import of `AgentServerClient` from
 *      `src/lib/agent-http-client`. The host owns the HTTP/SSE
 *      transport; the renderer only sees the typed callback.
 *
 * Adding a new cross-boundary capability:
 *   1. Declare the function on `ConductorHost` below.
 *   2. Add the implementation in `src/conductor-host-provider.tsx`.
 *   3. Consume via `useConductorHost()` inside the renderer module.
 */

import { createContext, useContext } from "react";
import type { RefineLlmResponse } from "./refine/types";

/**
 * Subset of the host's `Provider` row that the conductor model
 * selector needs. Mirrors `Provider` from `src/lib/ipc-client.ts`
 * but is owned by the package to avoid a reverse import.
 */
export interface ConductorProvider {
  id: string;
  name: string;
  providerType: string;
  hasApiKey: boolean;
  options: string;
  isDefault?: boolean;
}

/**
 * Model option shape used by the conductor composer and the
 * shared `<ModelSelector>`. Mirrors `ModelOption` from
 * `src/components/chat/ModelSelector.tsx`.
 */
export interface ModelOption {
  id: string;
  display_name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
}

/**
 * `ModelOption` augmented with the provider that supplied it.
 * Internal to the conductor model listing.
 */
export type ConductorModelInfo = ModelOption & { providerId?: string };

/**
 * The host-owned transport for the conductor refine agent. The
 * renderer never reaches `window.electronAPI` or the Agent Server
 * directly — it asks the host to do it.
 */
export interface ConductorAgent {
  /**
   * Drive one LLM call for a refine iteration. The host streams
   * the response and returns the final structured payload.
   */
  callRefine(args: {
    sessionId: string;
    userRequest: string;
    widgetType: string;
    currentData: Record<string, unknown>;
    iteration: number;
    maxIterations: number;
    screenshotBase64: string;
  }): Promise<RefineLlmResponse>;
}

/**
 * Settings access contract for the conductor. The host wraps its
 * settings storage (e.g. Electron's settingsDb) behind this typed
 * interface so the conductor package never reaches into
 * `window.electronAPI` directly.
 */
export interface ConductorHostSettings {
  /** Read a JSON-valued setting, returning `defaultValue` if missing. */
  getJson<T>(key: string, defaultValue: T): Promise<T>;
  /** Write a JSON-valued setting. */
  setJson<T>(key: string, value: T): Promise<void>;
  /** Read a string-valued setting, returning `null` if missing. */
  getString(key: string): Promise<string | null>;
  /** Write a string-valued setting. */
  setString(key: string, value: string): Promise<void>;
}

/**
 * Everything the renderer module needs from the host application.
 */
export interface ConductorHost {
  listProviders: () => Promise<ConductorProvider[]>;
  agent: ConductorAgent;
  /** Settings persistence (model, vision model, permission mode, etc.) */
  settings: ConductorHostSettings;
}

const ConductorHostContext = createContext<ConductorHost | null>(null);

export { ConductorHostContext };

/**
 * React hook — returns the active host. Throws if used outside a
 * `<ConductorHostProvider>`, so consumers fail loudly during dev
 * rather than silently no-oping.
 */
export function useConductorHost(): ConductorHost {
  const host = useContext(ConductorHostContext);
  if (!host) {
    throw new Error(
      "useConductorHost() called outside <ConductorHostProvider>. " +
        "Wrap the conductor tree in the host provider (see src/conductor-host-provider.tsx).",
    );
  }
  return host;
}

/**
 * Read the host from a non-React context. The provider must have
 * been mounted first; this is intended for use inside zustand
 * stores and other module-level code that fires on user actions,
 * not for first-render data fetching.
 */
export function getConductorHostOrNull(): ConductorHost | null {
  return readHostFromScope();
}

// ---------------------------------------------------------------------------
// Module-scope host binding
// ---------------------------------------------------------------------------
//
// Zustand stores cannot call `useContext` directly. We expose a tiny
// module-scope slot that `<ConductorHostProvider>` writes to on mount
// and that stores read from at call time. This keeps the inversion
// clean: the package never imports from the host, but the host can
// still satisfy store-initiated requests.

let scopeHost: ConductorHost | null = null;

export function setConductorHostScope(host: ConductorHost | null): void {
  scopeHost = host;
}

function readHostFromScope(): ConductorHost | null {
  return scopeHost;
}

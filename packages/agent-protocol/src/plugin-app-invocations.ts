/** Host-owned, short-lived bindings for Plugin App tool invocation. */
export interface PluginAppInvocationBindInput {
  /** Installed selector supplied by trusted Main code, never by the iframe. */
  readonly pluginId: string;
  readonly appId: string;
  readonly instanceId: string;
  readonly sessionId: string;
}

export interface PluginAppInvocationBinding {
  readonly bindingId: string;
  readonly nonce: string;
  readonly pluginId: string;
  readonly appId: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly stateSchemaVersion: number;
}

export interface PluginAppInvocationInput {
  readonly bindingId: string;
  readonly nonce: string;
  readonly toolId: string;
  readonly arguments: Record<string, unknown>;
  readonly requestId?: string;
}

/** MCP descriptor identity and schema revision captured from one live worker generation. */
export interface PluginAppMcpDescriptor {
  readonly toolId: string;
  readonly descriptor: Readonly<Record<string, string>>;
  readonly schemaRevision: string;
}

export type PluginAppInvocationResult =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Narrow resource data allowed to cross the worker boundary for a UI surface. */
export interface PluginAppResourceRead {
  readonly source: string;
  readonly pluginId?: string;
  readonly serverName: string;
  readonly contents: ReadonlyArray<{
    readonly uri: string;
    readonly mimeType?: string;
    readonly text?: string;
    readonly blob?: string;
  }>;
}

/** Called only by trusted Main code through the authenticated local Host API. */
export interface HostPluginAppInvocationApiV1 {
  bindPluginAppInvocation(input: PluginAppInvocationBindInput): Promise<PluginAppInvocationBinding>;
  invokePluginAppTool(input: PluginAppInvocationInput): Promise<PluginAppInvocationResult>;
  revokePluginAppInvocation(bindingId: string, nonce: string): Promise<boolean>;
}

/**
 * One MCP tool, addressed by the MCP protocol identity the declaring
 * plugin's manifest used. The Host resolves it against the live catalog by
 * canonical tool identity, so a display name never satisfies a mapping and
 * a same-named tool from another plugin never does either.
 */
export interface PluginAppCapabilityTool {
  readonly serverName: string;
  readonly toolName: string;
}

/**
 * A user's standing grant for one App capability.
 *
 * `mappingRevision` and `tools` record the tool scope the user actually
 * saw and approved. When the plugin later widens its mapping, the stored
 * scope no longer covers it and the grant stops applying until the user
 * approves the wider scope again.
 */
export interface PluginAppCapabilityGrant {
  readonly pluginId: string;
  readonly appId: string;
  readonly capability: string;
  readonly mappingRevision: string;
  readonly tools: readonly PluginAppCapabilityTool[];
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

export interface PluginAppGrantListInput {
  readonly pluginId: string;
  readonly appId: string;
}

export interface PluginAppGrantWriteInput {
  readonly pluginId: string;
  readonly appId: string;
  readonly capability: string;
  /** Exact tool scope shown by the privileged caller; Host verifies it against the current manifest. */
  readonly tools: readonly PluginAppCapabilityTool[];
}

/**
 * Grant administration over the authenticated, no-browser-Origin local API.
 *
 * An App frame can neither create, widen, nor restore a grant: the route
 * requires the local bearer token and rejects browser Origins. The Host
 * derives the stored mapping revision and accepts only the exact current
 * manifest tool scope. A human approval UI is a separate integration step.
 */
export interface HostPluginAppGrantApiV1 {
  listPluginAppGrants(input: PluginAppGrantListInput): Promise<readonly PluginAppCapabilityGrant[]>;
  grantPluginAppCapability(input: PluginAppGrantWriteInput): Promise<PluginAppCapabilityGrant>;
  revokePluginAppCapability(input: {
    readonly pluginId: string;
    readonly appId: string;
    readonly capability: string;
  }): Promise<boolean>;
}

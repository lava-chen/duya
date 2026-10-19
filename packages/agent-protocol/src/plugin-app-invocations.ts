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

/** Called only by trusted Main code through the authenticated local Host API. */
export interface HostPluginAppInvocationApiV1 {
  bindPluginAppInvocation(input: PluginAppInvocationBindInput): Promise<PluginAppInvocationBinding>;
  invokePluginAppTool(input: PluginAppInvocationInput): Promise<PluginAppInvocationResult>;
  revokePluginAppInvocation(bindingId: string, nonce: string): Promise<boolean>;
}

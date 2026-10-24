import type {
  PluginAppInvocationResult,
  PluginAppMcpDescriptor,
  PluginAppResourceRead,
} from '@duya/agent-protocol';

/** Narrow Main ↔ Desktop Agent Server control messages for Plugin App calls. */
export type DesktopPluginAppServerRequest =
  | { readonly type: 'desktop-plugin-app:request'; readonly requestId: string; readonly operation: 'current-attempt'; readonly sessionId: string }
  | { readonly type: 'desktop-plugin-app:request'; readonly requestId: string; readonly operation: 'validate-attempt'; readonly sessionId: string; readonly runId: string; readonly epoch: number; readonly workerGeneration: number }
  | { readonly type: 'desktop-plugin-app:request'; readonly requestId: string; readonly operation: 'describe-tools'; readonly sessionId: string; readonly runId: string; readonly epoch: number }
  | { readonly type: 'desktop-plugin-app:request'; readonly requestId: string; readonly operation: 'invoke-tool'; readonly sessionId: string; readonly runId: string; readonly epoch: number; readonly workerGeneration: number; readonly bindingId: string; readonly nonce: string; readonly toolId: string; readonly schemaRevision: string; readonly capabilityId: string; readonly arguments: Record<string, unknown> }
  | { readonly type: 'desktop-plugin-app:request'; readonly requestId: string; readonly operation: 'read-resource'; readonly sessionId: string; readonly pluginId: string; readonly server: string; readonly resourceUri: string };

export type DesktopPluginAppServerCall = DesktopPluginAppServerRequest extends infer Request
  ? Request extends DesktopPluginAppServerRequest
    ? Omit<Request, 'type' | 'requestId'>
    : never
  : never;

export type DesktopPluginAppServerResult =
  | { readonly attempt: { readonly runId: string; readonly epoch: number; readonly workerGeneration: number } | null }
  | { readonly current: boolean }
  | { readonly tools: readonly PluginAppMcpDescriptor[]; readonly workerGeneration: number }
  | { readonly result: PluginAppInvocationResult }
  | { readonly resource: PluginAppResourceRead; readonly workerGeneration: number };

export type DesktopPluginAppServerResponse =
  | { readonly type: 'desktop-plugin-app:response'; readonly requestId: string; readonly success: true; readonly result: DesktopPluginAppServerResult }
  | { readonly type: 'desktop-plugin-app:response'; readonly requestId: string; readonly success: false; readonly error: { readonly code: string; readonly message: string } };

export interface DesktopPluginAppAttempt {
  readonly runId: string;
  readonly workerGeneration: number;
}

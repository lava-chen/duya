/**
 * Connector tool descriptors — Plan 312 Phase 3.
 *
 * A {@link ConnectorToolDescriptor} is the LLM-facing shape of a tool
 * whose actual API call happens in the main process. Descriptors are
 * sent to the agent process (without tokens); when the agent invokes
 * the tool, the call is bridged back via `appConnection:invoke` IPC.
 *
 * Per the plan, each provider ships a minimal smoke toolset here
 * (1-2 read-only tools). The full tool catalog belongs to Plan 313.
 */

import type { ProviderId, RiskTier } from './types.js';

/**
 * JSON-schema subset compatible with the agent's `Tool.input_schema`.
 * The agent side re-uses this verbatim — no token fields ever appear.
 */
export interface ConnectorInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * Describes a connector tool the agent can discover via `tool_search`
 * and invoke. The descriptor is provider-owned; the executor lives in
 * the main process.
 */
export interface ConnectorToolDescriptor {
  /** LLM-visible tool name, e.g. `google_drive_list_files`. */
  name: string;
  /** Short description shown to the LLM. */
  description: string;
  /** JSON-schema for the tool's input parameters (LLM-facing). */
  inputSchema: ConnectorInputSchema;
  /** Concise summary used by `tool_search` for ranking. */
  inputSchemaSummary: string;
  /** Risk tier — drives the agent-side permission gate (Plan 312 §6). */
  riskTier: RiskTier;
  /** Owning provider. */
  provider: ProviderId;
  /**
   * Connection id this descriptor is bound to. The agent-side executor
   * passes this back to the main process so the right token is used.
   */
  connectionId: string;
  /**
   * Connector-internal action key (e.g. `drive.list_files`). The
   * descriptor's `name` is the LLM-facing alias; `action` is the
   * stable dispatch key the connector's `invoke()` switches on.
   */
  action: string;
}

/** Result of a connector invocation returned to the agent. */
export interface ConnectorInvokeResult {
  /** True when the provider API call succeeded. */
  success: boolean;
  /** Structured data (already redacted) for the agent to consume. */
  data?: unknown;
  /** Error envelope on failure. */
  error?: { code: string; message: string; retriable: boolean };
}

/**
 * Per-provider connector module. The main process owns instances of
 * this interface; the agent process only sees the descriptors.
 */
export interface ConnectorModule {
  /** Provider id this connector serves. */
  provider: ProviderId;
  /** Stable list of tool descriptors (no tokens). */
  listDescriptors(connectionId: string): ConnectorToolDescriptor[];
  /**
   * Execute an action with a pre-fetched access token. The connector
   * attaches the token to outbound HTTP requests itself; tokens never
   * leave this method's call frame.
   */
  invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult>;
}

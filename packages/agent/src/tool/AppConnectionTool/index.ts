/**
 * AppConnectionTool — agent-side connector tool executor. Plan 312 Phase 3.
 *
 * Each connected App Connection produces one or more
 * {@link ConnectorToolDescriptor}s. This module converts a descriptor
 * into a `Tool` definition + `ToolExecutor` pair that the agent's
 * ToolRegistry can register.
 *
 * Execution flow:
 *   1. The LLM calls the tool with input arguments.
 *   2. The executor forwards `{ connectionId, action, args }` to the
 *      main process via `context.ipcRequest('appConnection:invoke', ...)`.
 *   3. The main process (ConnectorService) resolves the connection,
 *      acquires a valid token, dispatches to the provider connector,
 *      and returns a redacted result.
 *   4. The executor formats the result as a JSON string for the LLM.
 *
 * Tokens NEVER enter the agent process — the IPC payload carries only
 * `connectionId` / `action` / `args`; the response carries only data
 * or a structured error.
 */

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor, ToolMetaInput } from '../registry.js';

/**
 * Descriptor shape sent from the main process. Mirrors
 * `ConnectorToolDescriptor` from the electron side, but kept as a
 * local type so the agent package does not import from electron.
 */
export interface AppConnectionToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  inputSchemaSummary: string;
  riskTier: 'read' | 'draft' | 'write' | 'modify' | 'destructive';
  /**
   * How `riskTier` was derived (Plan 449): `'annotations'` means the remote
   * server published hints we trusted for a read tier; `'fallback'` means
   * fail-closed defaulting.
   */
  tierSource?: 'annotations' | 'fallback';
  /** Human-readable tool title from server annotations (approval UI). */
  title?: string;
  /**
   * True when the user globally approved this provider+tool pair (Plan 449).
   * The permission gate skips the write/modify ask for this tool; destructive
   * strong-confirm is never skipped.
   */
  preApproved?: boolean;
  provider: string;
  /**
   * Display label stamped by the main process (Plan 450 Phase G), e.g.
   * `Notion`. Consumed by the mentions framework for prompt rendering;
   * absent when the descriptor came from an older main process.
   */
  providerLabel?: string;
  connectionId: string;
  action: string;
}

/**
 * Build the agent-side `Tool` definition from a descriptor.
 * The `input_schema` is forwarded as-is so the LLM sees the same shape
 * the connector module declared.
 */
function buildToolDefinition(desc: AppConnectionToolDescriptor): Tool {
  return {
    name: desc.name,
    description: desc.description,
    input_schema: {
      ...desc.inputSchema,
      // Ensure `type: 'object'` is always present (defensive).
      type: 'object' as const,
    },
  };
}

/**
 * Build the `ToolExecutor` for a descriptor. The executor calls
 * `context.ipcRequest` to route the invocation to the main process.
 */
function buildExecutor(desc: AppConnectionToolDescriptor): ToolExecutor {
  return {
    async execute(
      input: Record<string, unknown>,
      _workingDirectory?: string,
      context?: ToolUseContext,
    ): Promise<ToolResult> {
      const toolName = desc.name;

      if (!context?.ipcRequest) {
        return {
          id: crypto.randomUUID(),
          name: toolName,
          result: JSON.stringify({
            success: false,
            error: {
              code: 'NO_IPC',
              message: 'IPC not available — App Connection tools require the main process bridge.',
            },
          }),
          error: true,
        };
      }

      const response = await context.ipcRequest(
        'appConnection:invoke',
        {
          connectionId: desc.connectionId,
          action: desc.action,
          args: input,
        },
        { timeout: 60_000 },
      );

      if (!response.success) {
        const error = response.error ?? { code: 'UNKNOWN', message: 'Unknown error' };
        // Plan 450: connector_auth_required mid-call → fire a structured
        // SSE event so the renderer can show a re-authorization card.
        // The agent itself only sees the standard error; the elicitation
        // surface lives in the UI (mirroring codex auth_elicitation).
        if (error.code === 'connector_auth_required' && context.sendToMain) {
          context.sendToMain({
            type: 'chat:connector_auth_required',
            sessionId: context.options?.sessionId,
            toolName,
            provider: desc.provider,
            connectionId: desc.connectionId,
          });
        }
        // Surface `connection_not_available` / `connection_revoked` with
        // a user-actionable hint so the LLM can tell the user to reconnect.
        // Plan 498: for `connector_auth_required` the renderer already drew
        // the re-authorization card (SSE event above) — mirror grok-bot's
        // AuthenticateMcpServer contract: tell the model to stop retrying,
        // finish other work, and end the turn. The UI resumes it with a
        // follow-up message once the user completes authorization.
        const message =
          error.code === 'connector_auth_required'
            ? `${error.message} A re-authorization card for ${desc.provider} has been shown to the user in the chat UI. Do NOT retry this call right now — finish any other useful work, then end your turn. The user will complete authorization in the browser, and the UI will automatically send a follow-up message so you can re-issue this call with the same arguments.`
            : error.code === 'connection_not_available' ||
                error.code === 'connection_revoked' ||
                error.code === 'connection_not_found'
              ? `${error.message} — the user may need to reconnect the ${desc.provider} account.`
              : error.message;
        return {
          id: crypto.randomUUID(),
          name: toolName,
          result: JSON.stringify({ success: false, error: { ...error, message } }),
          error: true,
        };
      }

      return {
        id: crypto.randomUUID(),
        name: toolName,
        result: JSON.stringify({ success: true, data: response.data }),
        error: false,
      };
    },
  };
}

/**
 * Build the `ToolMetaInput` for a descriptor. Connector tools are
 * `discoverable`: they enter the LLM's default tool list only when the user
 * @-mentions their provider this turn (exposure promotion in
 * `DuyaAgent._resolveTools`), or after `tool_search` surfaces them. The
 * persistent "Apps (Connectors)" system section keeps the model aware of
 * what exists either way.
 *
 * Plan 312 Phase 4: the `riskTier` is forwarded so the permission gate
 * can apply tier-based gating (read/draft auto-execute, write/modify
 * confirm, destructive strong-confirm).
 */
function buildMeta(desc: AppConnectionToolDescriptor): ToolMetaInput {
  return {
    exposeMode: 'discoverable',
    inputSchemaSummary: desc.inputSchemaSummary,
    riskTier: desc.riskTier,
  };
}

/**
 * Factory: convert a descriptor into a registry-ready triple.
 * The caller registers these with `registry.register(def, executor, meta)`.
 */
export function createAppConnectionTool(desc: AppConnectionToolDescriptor): {
  definition: Tool;
  executor: ToolExecutor;
  meta: ToolMetaInput;
} {
  return {
    definition: buildToolDefinition(desc),
    executor: buildExecutor(desc),
    meta: buildMeta(desc),
  };
}

/**
 * Plan 450 (Phase C): single-descriptor inputSchema byte budget. Mirrors
 * codex's `MAX_AGENT_PLUGIN_MCP_SPEC_BYTES = 8_000` — any hosted MCP
 * descriptor whose serialized inputSchema exceeds this is registered
 * with an empty object schema + summary folded into the description.
 * Keeps the model prompt bounded when a remote server advertises a
 * pathologically large schema (e.g. a hundred-property wrapper).
 */
export const APP_CONNECTION_SPEC_BYTE_BUDGET = 8192;

function downgradeForByteBudget(desc: AppConnectionToolDescriptor): AppConnectionToolDescriptor {
  let size: number;
  try {
    size = JSON.stringify(desc.inputSchema).length;
  } catch {
    size = APP_CONNECTION_SPEC_BYTE_BUDGET + 1;
  }
  if (size <= APP_CONNECTION_SPEC_BYTE_BUDGET) return desc;
  // Lossy fallback: surface the tool's intent via description so
  // tool_search / the model still know what the tool is for, and
  // disable structured input by replacing the schema with an empty
  // object. The executor still receives the raw `args` JSON from the
  // model so it can fall back to forwarding whatever the host server
  // accepted before this rewrite.
  return {
    ...desc,
    inputSchema: { type: 'object', properties: {} },
    description: `${desc.description}\n\n[Schema truncated: ${size} bytes exceeds ${APP_CONNECTION_SPEC_BYTE_BUDGET}-byte budget; use ${desc.inputSchemaSummary}.]`,
  };
}

/**
 * Register an array of descriptors into a ToolRegistry. Removes any
 * previously-registered connector tools first (by name) so reloads
 * don't leave stale entries.
 */
export function registerAppConnectionTools(
  registry: import('../registry.js').ToolRegistry,
  descriptors: AppConnectionToolDescriptor[],
): { added: number; removed: number; downgraded: number } {
  // No cleanup needed — the per-turn registry from createBuiltinRegistry
  // is fresh, so there are no stale connector tools to remove. But
  // for safety (e.g. when a custom registry is passed via options),
  // we still check and remove existing connector-prefixed tools.
  const _existingTools = registry.getAllTools();
  const newNames = new Set(descriptors.map((d) => d.name));
  const connectorPrefixes = ['google_', 'slack_', 'microsoft_', 'wecom_'];
  let removed = 0;
  for (const tool of _existingTools) {
    if (!newNames.has(tool.name) && connectorPrefixes.some((p) => tool.name.startsWith(p))) {
      registry.unregister(tool.name);
      removed++;
    }
  }

  let added = 0;
  let downgraded = 0;
  for (const rawDesc of descriptors) {
    const desc = downgradeForByteBudget(rawDesc);
    if (desc !== rawDesc) downgraded++;
    if (registry.has(desc.name)) {
      registry.unregister(desc.name);
    }
    const { definition, executor, meta } = createAppConnectionTool(desc);
    registry.register(definition, executor, meta);
    added++;
  }

  return { added, removed, downgraded };
}

// --- Descriptor cache ---
//
// Plan 312: descriptors are fetched from the main process at init/reload
// time and cached here. The per-turn registry merge in DuyaAgent reads
// from this cache — it does NOT do an IPC round-trip per turn.

let cachedDescriptors: AppConnectionToolDescriptor[] = [];

/** Update the cached descriptor list (called after init/reload). */
export function setCachedAppConnectionDescriptors(descriptors: AppConnectionToolDescriptor[]): void {
  cachedDescriptors = descriptors;
}

/** Read the cached descriptor list (called per-turn by DuyaAgent). */
export function getCachedAppConnectionDescriptors(): AppConnectionToolDescriptor[] {
  return cachedDescriptors;
}

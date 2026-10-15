/**
 * AppConnectionTool — connector invocation capability. Plan 312 Phase 3.
 *
 * Each connected App Connection produces one or more
 * {@link ConnectorToolDescriptor}s. This module converts a descriptor
 * into a `Tool` definition + `ToolExecutor` pair that the agent's
 * ToolRegistry can register.
 *
 * Execution flow:
 *   1. The LLM calls the tool with input arguments.
 *   2. The executor forwards `{ connectionId, action, args }` through a
 *      narrow Host-owned invocation port.
 *   3. The main process (ConnectorService) resolves the connection,
 *      acquires a valid token, dispatches to the provider connector,
 *      and returns a redacted result.
 *   4. The executor formats the result as a JSON string for the LLM.
 *
 * Tokens NEVER enter the agent process — the IPC payload carries only
 * `connectionId` / `action` / `args`; the response carries only data
 * or a structured error.
 */

import type { ToolResult } from '../contracts/tool.js';
import { connectionNamespace } from '@duya/plugin-core/mcp/core/alias';
import { composeResultFromBlocks } from '../MCP/result-blocks.js';
import type {
  AppConnectionToolContext,
  AppConnectionToolDefinition,
  AppConnectionToolDescriptor,
  AppConnectionToolExecutor,
  ConnectorReplaceSetPort,
  ConnectorToolMetaInput,
} from './ports.js';

export type { AppConnectionToolDescriptor } from './ports.js';
export type {
  AppConnectionInvokePort,
  AppConnectionInvokeRequest,
  AppConnectionInvokeResponse,
  AppConnectionToolContext,
  AppConnectionToolDefinition,
  AppConnectionToolExecutor,
  AppConnectionRiskTier,
  ConnectorReauthorizationRequest,
  ConnectorReplaceSetPort,
  ConnectorReplaceSetResult,
  ConnectorToolMetaInput,
} from './ports.js';

/**
 * Plan 580 D5: chain-B per-call deadline, mirroring chain A's default
 * tool-call cap (120s). The worker stamps an absolute `deadlineAt`; the
 * main process honors it via the SDK's per-request `{ timeout, signal }`.
 * The IPC wait gets a +30s buffer so the main side times out FIRST and
 * returns a structured error instead of the IPC layer racing it.
 */
const CHAIN_B_TOOL_TIMEOUT_MS = 120_000;
const CHAIN_B_IPC_BUFFER_MS = 30_000;

/**
 * Descriptor shape sent from the main process. Mirrors
 * `ConnectorToolDescriptor` from the electron side, but kept as a
 * local type so the agent package does not import from electron.
 */
/**
 * Build the agent-side `Tool` definition from a descriptor.
 * Plan 580 D4: the canonical `input_schema` is forwarded VERBATIM — the
 * legacy unconditional `type: 'object'` overwrite is gone (it corrupted
 * combinator roots before the registry could hash the canonical form).
 */
function buildToolDefinition(desc: AppConnectionToolDescriptor): AppConnectionToolDefinition {
  return {
    name: desc.name,
    description: desc.description,
    input_schema: desc.inputSchema,
  };
}

/**
 * Build the `ToolExecutor` for a descriptor. The executor calls
 * the context's narrow Host invocation port to route the call.
 */
function buildExecutor(desc: AppConnectionToolDescriptor): AppConnectionToolExecutor {
  return {
    async execute(
      input: Record<string, unknown>,
      _workingDirectory?: string,
      context?: AppConnectionToolContext,
    ): Promise<ToolResult> {
      const toolName = desc.name;

      const invokePort = context?.appConnection;
      if (!invokePort) {
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

      // Plan 580 D5: one absolute deadline per call, computed here and
      // honored main-side (SDK per-request timeout+signal; the shared
      // transport is never closed for an aborted call).
      const deadlineAt = Date.now() + CHAIN_B_TOOL_TIMEOUT_MS;
      const response = await invokePort.invoke(
        {
          connectionId: desc.connectionId,
          action: desc.action,
          args: input,
          deadlineAt,
        },
        { timeout: CHAIN_B_TOOL_TIMEOUT_MS + CHAIN_B_IPC_BUFFER_MS },
      );

      if (!response.success) {
        const error = response.error ?? { code: 'UNKNOWN', message: 'Unknown error' };
        // Plan 450: connector_auth_required mid-call → fire a structured
        // SSE event so the renderer can show a re-authorization card.
        // The agent itself only sees the standard error; the elicitation
        // surface lives in the UI (mirroring codex auth_elicitation).
        if (error.code === 'connector_auth_required' && invokePort.requestReauthorization) {
          invokePort.requestReauthorization({
            sessionId: context?.options?.sessionId,
            toolName,
            provider: desc.provider,
            connectionId: desc.connectionId,
            variant: 'reauth',
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

      // Plan 580 D8: for the remote-MCP binding the main process returns
      // `data.content` as the MCP content array. Compose the model-visible
      // text with the SHARED last-mile (text verbatim + bounded metadata
      // lines), and save the canonical blocks losslessly in
      // `ToolResult.blocks`. Other bindings (REST / custom) keep the JSON
      // envelope — their data never contains base64 media blocks.
      const data = response.data as { content?: unknown; isError?: boolean } | unknown;
      const mcpContent = (data && typeof data === 'object' && Array.isArray((data as { content?: unknown }).content))
        ? (data as { content: unknown[] }).content
        : undefined;
      if (mcpContent) {
        const composed = composeResultFromBlocks(mcpContent);
        const isError = (data as { isError?: boolean }).isError === true;
        return {
          id: crypto.randomUUID(),
          name: toolName,
          result: composed.text,
          ...(composed.hasNonText ? { blocks: mcpContent } : {}),
          ...(isError ? { error: true } : {}),
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
 * `deferred`: they enter the LLM's direct tool list only when the user
 * @-mentions their provider this turn (exposure promotion in
 * `DuyaAgent._resolveTools`), or after `tool_catalog` surfaces them. The
 * persistent "Apps (Connectors)" system section keeps the model aware of
 * what exists either way.
 *
 * Plan 312 Phase 4: the `riskTier` is forwarded so the permission gate
 * can apply tier-based gating (read/draft auto-execute, write/modify
 * confirm, destructive strong-confirm).
 */
function buildMeta(desc: AppConnectionToolDescriptor): ConnectorToolMetaInput {
  return {
    exposure: 'deferred',
    source: { kind: 'connector', id: desc.provider },
    discovery: {
      // Plan 580 D7: stable per-connection namespace — the provider's
      // first connection holds the bare provider id for life; later
      // ones get `provider:<slug>`. Never a full UUID.
      namespace: connectionNamespace(desc.provider, desc.connectionSlug ?? ''),
      conciseHint: desc.description,
      tags: [desc.provider, desc.name],
    },
    inputSchemaSummary: desc.inputSchemaSummary,
    riskTier: desc.riskTier,
  };
}

/**
 * Factory: convert a descriptor into a registry-ready triple.
 * The caller registers these with `registry.register(def, executor, meta)`.
 */
export function createAppConnectionTool(desc: AppConnectionToolDescriptor): {
  definition: AppConnectionToolDefinition;
  executor: AppConnectionToolExecutor;
  meta: ConnectorToolMetaInput;
} {
  return {
    definition: buildToolDefinition(desc),
    executor: buildExecutor(desc),
    meta: buildMeta(desc),
  };
}

/**
 * Plan 580 Phase 2C (D6): connection owners whose bucket must be
 * authoritatively emptied on the next `registerAppConnectionTools`
 * call. Populated by `setCachedAppConnectionDescriptors` when a
 * previously-known connection disappears from the connected set
 * (`connection:removed`); NEVER populated for a connection that is
 * still connected but whose fresh discovery failed (`discovery:failed`
 * keeps the last-known inventory).
 */
const pendingRemovedOwners = new Set<string>();

/**
 * Register connector descriptors into a ToolRegistry.
 *
 * Plan 580 Phase 2C (D6): descriptors are bucketed per connection and
 * each bucket is committed through `registry.replaceByOwner(
 * `connector:${connectionId}`, …)` — a strict validate-then-commit
 * replace-set. Reload diffs (46 → 45 after one tool disappears) land
 * as kept/removed keys of the same commit; the legacy prefix-table
 * cleanup is gone (it only ever covered `google_/slack_/microsoft_/
 * wecom_` and leaked `remote_*` ghost tools).
 */
export function registerAppConnectionTools<TExecutor = AppConnectionToolExecutor>(
  registry: ConnectorReplaceSetPort<TExecutor>,
  descriptors: AppConnectionToolDescriptor[],
  adaptExecutor: (executor: AppConnectionToolExecutor) => TExecutor =
    ((executor) => executor as unknown as TExecutor),
): { added: number; removed: number; downgraded: number } {
  let added = 0;
  let removed = 0;

  // D6 `connection:removed` → authoritative empty replace.
  for (const owner of pendingRemovedOwners) {
    try {
      const result = registry.replaceByOwner(owner as `connector:${string}`, []);
      removed += result.removedKeys.length;
    } catch {
      // Bucket absent (e.g. a fresh per-turn registry) — nothing to clear.
    }
  }
  pendingRemovedOwners.clear();

  // D6 `discovery:succeeded` → authoritative replace, one bucket per connection.
  const buckets = new Map<
    string,
    Array<{
      key: string;
      definition: AppConnectionToolDefinition;
      executor: TExecutor;
      meta: ConnectorToolMetaInput;
    }>
  >();
  for (const desc of descriptors) {
    const owner = `connector:${desc.connectionId}`;
    let bucket = buckets.get(owner);
    if (!bucket) {
      bucket = [];
      buckets.set(owner, bucket);
    }
    const { definition, executor, meta } = createAppConnectionTool(desc);
    bucket.push({ key: definition.name, definition, executor: adaptExecutor(executor), meta });
  }
  for (const [owner, entries] of buckets) {
    const result = registry.replaceByOwner(owner as `connector:${string}`, entries);
    added += result.addedKeys.length;
    removed += result.removedKeys.length;
  }

  return { added, removed, downgraded: 0 };
}

// --- Descriptor cache ---
//
// Plan 312: descriptors are fetched from the main process at init/reload
// time and cached here. The per-turn registry merge in DuyaAgent reads
// from this cache — it does NOT do an IPC round-trip per turn.

let cachedDescriptors: AppConnectionToolDescriptor[] = [];

/**
 * Update the cached descriptor list (called after init/reload).
 *
 * Plan 580 Phase 2C (D6): the three replace-set events are
 * distinguished here:
 *   - a cached connection absent from the connected set →
 *     `connection:removed` → its bucket is queued for an authoritative
 *     empty replace on the next registration;
 *   - a connected connection with NO fresh descriptors and NOT in the
 *     discovery-failure set → `discovery:succeeded` with an empty
 *     inventory → its bucket is queued for an authoritative empty
 *     replace too (the remote server genuinely lost all its tools);
 *   - a connected connection in the discovery-failure set →
 *     `discovery:failed` → its last-known descriptors are kept, so the
 *     registry bucket is NOT replaced (and NOT cleared);
 *   - fresh descriptors → `discovery:succeeded` → next registration
 *     replaces that bucket.
 *
 * When the main process does NOT report a connected set (pre-580
 * caller), the flat descriptor list is the whole truth: every cached
 * connection missing from it is queued for an empty replace (the
 * legacy full-swap behaviour).
 */
export function setCachedAppConnectionDescriptors(
  descriptors: AppConnectionToolDescriptor[],
  connectedConnectionIds?: string[],
  discoveryFailedConnectionIds?: string[],
): void {
  const connectedSet = connectedConnectionIds ? new Set(connectedConnectionIds) : undefined;
  const failedSet = discoveryFailedConnectionIds ? new Set(discoveryFailedConnectionIds) : undefined;
  const freshConnections = new Set(descriptors.map((d) => d.connectionId));
  let merged = descriptors;
  if (!connectedSet) {
    // Legacy full-swap: no authoritative connected set to reason with.
    for (const d of cachedDescriptors) {
      if (!freshConnections.has(d.connectionId)) {
        pendingRemovedOwners.add(`connector:${d.connectionId}`);
      }
    }
  } else {
    for (const d of cachedDescriptors) {
      if (!connectedSet.has(d.connectionId)) {
        // `connection:removed` — the user deleted/disconnected it.
        pendingRemovedOwners.add(`connector:${d.connectionId}`);
      } else if (!freshConnections.has(d.connectionId) && !failedSet?.has(d.connectionId)) {
        // Connected, absent from fresh discovery, and NOT reported as a
        // discovery failure → succeeded with an empty inventory.
        pendingRemovedOwners.add(`connector:${d.connectionId}`);
      }
      // else (failedSet.has) → `discovery:failed` — keep last-known.
    }
    const lastKnown = cachedDescriptors.filter(
      (d) =>
        !freshConnections.has(d.connectionId) &&
        connectedSet.has(d.connectionId) &&
        failedSet?.has(d.connectionId) === true,
    );
    if (lastKnown.length > 0) merged = [...descriptors, ...lastKnown];
  }
  cachedDescriptors = merged;
}

/** Read the cached descriptor list (called per-turn by DuyaAgent). */
export function getCachedAppConnectionDescriptors(): AppConnectionToolDescriptor[] {
  return cachedDescriptors;
}

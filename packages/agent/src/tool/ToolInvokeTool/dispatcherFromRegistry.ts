import { randomUUID } from 'node:crypto';

import type { ExposeMode, ToolRegistry } from '../registry.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolInvokeDispatcher, ToolInvokeRequest, ToolInvokeOutcome } from './ToolInvokeTool.js';
import { BUILTIN_TOOLS_NAMESPACE } from '../ToolSchemaTool/catalogFromRegistry.js';
import { logger } from '../../utils/logger.js';

/**
 * Plan 480 P2.2/P2.3 — registry-backed dispatcher for `tool_invoke`.
 *
 * Wires the invocation meta tool to the real permission chain and executor:
 *   resolve → permission (allow / deny / ask) → executor → outcome
 *
 * Resolution scope (must mirror the tool_schema catalog provider):
 *   - namespace = an MCP server name   → MCP-owned tools by `mcpInfo`
 *   - namespace = 'builtin'            → non-MCP `hint` / `discoverable`
 *                                        built-ins by definition name
 * The schema the model read via `tool_schema` and the tool that actually
 * runs come from the SAME registry, so discovery can never promise a tool
 * the executor cannot find.
 *
 * Permission semantics:
 *   - allow  → execute
 *   - deny   → structured error carrying the decision message
 *   - ask    → interactive approval through the turn's ToolUseContext.
 *              With a `requestPermission` channel (interactive session) the
 *              user gets a REAL approval card — deny/paused surface as
 *              structured errors, allow falls through to execution. Without
 *              a channel (headless CLI / sub-agent / background gateway
 *              session) there is no interactive user to answer and asking
 *              would dead-lock the turn, so the call proceeds implicitly
 *              with a loud warn — the same trust model the MCP runtime gate
 *              uses (mcp/apply.ts). The permission chain is still the gate:
 *              auto-approve modes reach `allow` before this branch.
 *
 * The permission check is a caller-injected function (DuyaAgent wraps its
 * `hasPermissionsToUseTool`), so this module stays unit-testable without a
 * live agent.
 */

export interface ToolInvokePermissionDecision {
  behavior: 'allow' | 'deny' | 'ask';
  /** Deny / ask message when the decision carries one. */
  message?: string;
}

export interface ToolInvokeDispatcherDeps {
  /** Turn-level registry containing the tool surface. */
  registry: ToolRegistry;
  /** Wraps the agent's permission chain for the resolved real tool name. */
  checkPermission: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<ToolInvokePermissionDecision>;
  /** Working directory forwarded to the executor. */
  workingDirectory?: string;
  /**
   * Lazily provides the turn's ToolUseContext for executor calls. Built-in
   * tools (builtin namespace) frequently depend on it; MCP executors ignore
   * it. Injected as a getter because the dispatcher is wired before the
   * per-turn context is constructed.
   */
  contextProvider?: () => ToolUseContext | undefined;
}

interface ResolvedTool {
  internalName: string;
  displayName: string;
  isBuiltin: boolean;
}

/**
 * Four-tier exposure: `tool_invoke` reaches exactly the tools whose full
 * schema is NOT declared on the request's tools array — `discoverable`
 * (found via tool_search) and `hint` (stub entry, deep-read via
 * tool_schema). `always` tools are declared already; `hidden` tools are
 * unreachable by any model path.
 */
function isInvocableThroughMetaTool(mode: ExposeMode): boolean {
  return mode === 'discoverable' || mode === 'hint';
}

function listNamespaces(registry: ToolRegistry): string[] {
  const namespaces = new Set<string>();
  let hasBuiltin = false;
  for (const tool of registry.getAllTools()) {
    if (registry.getOwner(tool.name) === 'mcp') {
      if (
        tool.mcpInfo &&
        registry.getExposeMode(tool.name) !== 'hidden'
      ) {
        namespaces.add(tool.mcpInfo.serverName);
      }
    } else if (isInvocableThroughMetaTool(registry.getExposeMode(tool.name))) {
      hasBuiltin = true;
    }
  }
  if (hasBuiltin) namespaces.add(BUILTIN_TOOLS_NAMESPACE);
  return [...namespaces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function resolveBuiltinTool(
  registry: ToolRegistry,
  toolName: string,
): ResolvedTool | undefined {
  for (const tool of registry.getAllTools()) {
    if (registry.getOwner(tool.name) !== 'mcp') {
      if (
        isInvocableThroughMetaTool(registry.getExposeMode(tool.name)) &&
        tool.name === toolName
      ) {
        return { internalName: tool.name, displayName: tool.name, isBuiltin: true };
      }
    }
  }
  return undefined;
}

function resolveMcpTool(
  registry: ToolRegistry,
  namespace: string,
  toolName: string,
): ResolvedTool | undefined {
  for (const tool of registry.getAllTools()) {
    if (registry.getOwner(tool.name) !== 'mcp') continue;
    if (registry.getExposeMode(tool.name) === 'hidden') continue;
    const info = tool.mcpInfo;
    if (!info) continue;
    if (info.serverName === namespace && info.toolName === toolName) {
      return { internalName: tool.name, displayName: info.toolName, isBuiltin: false };
    }
  }
  return undefined;
}

function listToolsInNamespace(
  registry: ToolRegistry,
  namespace: string,
): string[] {
  const names: string[] = [];
  for (const tool of registry.getAllTools()) {
    if (registry.getExposeMode(tool.name) === 'hidden') continue;
    if (namespace === BUILTIN_TOOLS_NAMESPACE) {
      if (
        registry.getOwner(tool.name) !== 'mcp' &&
        isInvocableThroughMetaTool(registry.getExposeMode(tool.name))
      ) {
        names.push(tool.name);
      }
    } else if (registry.getOwner(tool.name) === 'mcp' && tool.mcpInfo?.serverName === namespace) {
      names.push(tool.mcpInfo.toolName);
    }
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function errorResult(title: string, body: string): ToolInvokeOutcome {
  return { result: `# ${title}\n\n${body}`, error: true };
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createToolInvokeDispatcherFromRegistry(
  deps: ToolInvokeDispatcherDeps,
): ToolInvokeDispatcher {
  return {
    async dispatch(request: ToolInvokeRequest): Promise<ToolInvokeOutcome> {
      const { namespace, tool, arguments: args } = request;

      // 1. Resolve the real registered tool. Same registry feeds tool_schema
      //    discovery and this execution — no schema/executor drift.
      const resolved =
        namespace === BUILTIN_TOOLS_NAMESPACE
          ? resolveBuiltinTool(deps.registry, tool)
          : resolveMcpTool(deps.registry, namespace, tool);
      if (!resolved) {
        const namespaces = listNamespaces(deps.registry);
        const toolNames = listToolsInNamespace(deps.registry, namespace);
        if (namespaces.length === 0) {
          return errorResult(
            'Tool Invoke Error',
            `No tools are reachable through tool_invoke. Namespace \`${namespace}\` / tool \`${tool}\` cannot be resolved.`,
          );
        }
        if (toolNames.length === 0) {
          return errorResult(
            'Unknown namespace',
            `Namespace \`${namespace}\` is not connected.\n\nAvailable namespaces: ${namespaces
              .map((n) => `\`${n}\``)
              .join(', ')}.`,
          );
        }
        return errorResult(
          'Unknown tool',
          `Tool \`${tool}\` does not exist in namespace \`${namespace}\`.\n\nAvailable tools: ${toolNames
            .map((t) => `\`${t}\``)
            .join(', ')}.`,
        );
      }

      // 2. Permission gate on the RESOLVED real tool (permissions can never
      //    be bypassed by routing through the meta tool).
      const decision = await deps.checkPermission(resolved.internalName, args);
      if (decision.behavior === 'deny') {
        return errorResult(
          'Permission denied',
          decision.message
            ? decision.message
            : `The tool \`${tool}\` (namespace \`${namespace}\`) was denied by the permission policy.`,
        );
      }
      if (decision.behavior === 'ask') {
        const context = deps.contextProvider?.();
        if (context?.requestPermission) {
          // Interactive session: raise a REAL approval card through the
          // turn's permission_request flow (chat:permission event →
          // renderer Allow/Deny prompt). This mirrors the MCP runtime
          // gate (mcp/apply.ts) — prompting inside the executor keeps
          // allow/deny + execution in a single synchronous flow.
          const userDecision = await context.requestPermission({
            id: randomUUID(),
            toolName: resolved.internalName,
            toolInput: args,
            mode: 'generic',
            expiresAt: Date.now() + 5 * 60 * 1000,
            decisionReason: decision.message,
          });
          if (userDecision === 'deny') {
            logger.warn(
              '[ToolInvoke] tool call denied by user',
              { toolName: resolved.internalName, namespace },
            );
            return errorResult(
              'Permission denied',
              decision.message
                ? decision.message
                : `The user denied the call to \`${tool}\` (namespace \`${namespace}\`).`,
            );
          }
          // Plan 498: 'paused' means the request was persisted as a durable
          // approval card; the turn must NOT fall through to execution.
          // Surface the neutral waiting text; a later continuation run
          // replays the approved call via the one-shot approval ledger.
          if (userDecision === 'paused') {
            logger.info(
              '[ToolInvoke] tool call paused for durable approval card',
              { toolName: resolved.internalName, namespace },
            );
            return errorResult(
              'Waiting for approval',
              `The call to \`${tool}\` (namespace \`${namespace}\`) is waiting for user approval. ` +
                'The request has been sent as an approval card; end your turn without further tool calls.',
            );
          }
          // 'allow' → fall through to execution below.
        } else {
          // No interactive user available (headless CLI / sub-agent /
          // background gateway session): asking would dead-lock the turn.
          // These contexts are trusted app-internal/automation surfaces,
          // so allow implicitly with a loud warn — same semantics as the
          // MCP runtime gate (mcp/apply.ts).
          logger.warn(
            '[ToolInvoke] no interactive user available; implicitly allowing ask-tool',
            { toolName: resolved.internalName, namespace, reason: decision.message },
          );
        }
      }

      // 3. Execute through the registered executor (the same one direct calls
      //    use — no second implementation path). Built-in tools receive the
      //    turn's ToolUseContext; MCP executors ignore it.
      const executor = deps.registry.getExecutor(resolved.internalName);
      if (!executor) {
        return errorResult(
          'Tool Invoke Error',
          `Executor for \`${tool}\` (namespace \`${namespace}\`) is not registered.`,
        );
      }

      try {
        const context = resolved.isBuiltin
          ? deps.contextProvider?.()
          : undefined;
        const result = await executor.execute(
          args,
          deps.workingDirectory,
          context,
        );
        const text = result && typeof result === 'object'
          ? toText((result as { result?: unknown }).result)
          : toText(result);
        const isError =
          (result as { error?: boolean } | null)?.error === true;
        return {
          result:
            text ??
            `Tool \`${tool}\` returned no result.`,
          ...(isError ? { error: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          'Tool Invoke Failed',
          `Invoking \`${tool}\` in namespace \`${namespace}\` failed:\n\n${message}`,
        );
      }
    },
  };
}

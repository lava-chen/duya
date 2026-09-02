import type { ToolRegistry } from '../registry.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolInvokeDispatcher, ToolInvokeRequest, ToolInvokeOutcome } from './ToolInvokeTool.js';
import { BUILTIN_TOOLS_NAMESPACE } from '../ToolSchemaTool/catalogFromRegistry.js';

/**
 * Plan 480 P2.2/P2.3 — registry-backed dispatcher for `tool_invoke`.
 *
 * Wires the invocation meta tool to the real permission chain and executor:
 *   resolve → permission (allow / deny / ask) → executor → outcome
 *
 * Resolution scope (must mirror the tool_schema catalog provider):
 *   - namespace = an MCP server name   → MCP-owned tools by `mcpInfo`
 *   - namespace = 'builtin'            → non-MCP `discoverable` built-ins by
 *                                        definition name (plan 480 P2.3)
 * The schema the model read via `tool_schema` and the tool that actually
 * runs come from the SAME registry, so discovery can never promise a tool
 * the executor cannot find.
 *
 * Permission semantics (documented decision, plan 480 §8.10):
 *   - allow  → execute
 *   - deny   → structured error carrying the decision message
 *   - ask    → NOT executed. Interactive approval flows through the
 *              StreamingToolExecutor approval channel, which this dispatcher
 *              deliberately does not fake. The model receives an explicit
 *              message that the call needs user approval it cannot grant
 *              through `tool_invoke` (e.g. bypass/dontAsk modes allow).
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

function listNamespaces(registry: ToolRegistry): string[] {
  const namespaces = new Set<string>();
  let hasBuiltin = false;
  for (const tool of registry.getAllTools()) {
    if (registry.getOwner(tool.name) === 'mcp') {
      if (tool.mcpInfo) namespaces.add(tool.mcpInfo.serverName);
    } else if (registry.getExposeMode(tool.name) === 'discoverable') {
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
        registry.getExposeMode(tool.name) === 'discoverable' &&
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
    if (namespace === BUILTIN_TOOLS_NAMESPACE) {
      if (
        registry.getOwner(tool.name) !== 'mcp' &&
        registry.getExposeMode(tool.name) === 'discoverable'
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
        return errorResult(
          'Approval required',
          `The tool \`${tool}\` (namespace \`${namespace}\`) requires user approval, which cannot be granted through \`tool_invoke\`.\n\n${
            decision.message ? `${decision.message}\n\n` : ''
          }Ask the user to approve the operation, or retry when the session runs in an auto-approve mode.`,
        );
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

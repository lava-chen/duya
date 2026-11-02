import type { RuntimeToolResult, ToolExecutor } from './catalog/registry.js';
import { decideMcpSource } from '../authorization/permissions/permissions.js';
import { resolveAskWithoutUser } from '../authorization/permissions/askWithoutUser.js';
import type { PermissionMode, McpToolSource } from '../authorization/permissions/types.js';
import { withAppToolContext } from '@duya/capabilities/AppServer/app-tool-context';
import type {
  ToolExecutionLogger,
  ToolPermissionDecision,
  ToolPermissionRequest,
} from './execution/index.js';

export interface MCPExecutorPorts<TContext extends object> {
  getToolUseId(context: TContext): string | undefined;
  getPermissionMode(context: TContext): PermissionMode | undefined;
  getAppState(context: TContext): Record<string, unknown> | undefined;
  setAppState?(
    context: TContext,
    update: (previous: Record<string, unknown>) => Record<string, unknown>,
  ): void;
  requestPermission?(
    context: TContext,
    request: ToolPermissionRequest,
  ): Promise<ToolPermissionDecision | undefined>;
  /** Optional final authority check immediately before the captured side effect. */
  beforeInvoke?(context: TContext, input: Record<string, unknown>): Promise<boolean>;
  /**
   * Generation-currency check (plan tool-surface W1 residual; F18 direct-path
   * parity). The executor captures ONE MCP generation's `invoke` closure, and
   * an `ask` decision can park a call inside this executor for minutes. If a
   * replace-set lands in that window, the live registry no longer points at
   * THIS executor and executing would run the pre-replacement connection —
   * the exact "approved A, executed B" signature #558 closed on the routed
   * path. Implementations compare `registry.getExecutor(toolName)` with the
   * executor reference that runs; `false` fails the call with the named
   * `authority_revoked` gate error instead of executing stale.
   */
  isExecutorCurrent?(toolName: string, executor: object): boolean;
  logger?: ToolExecutionLogger;
}

export interface MCPToolExecutorOptions<TContext extends object> {
  toolName: string;
  source: McpToolSource;
  invoke(input: Record<string, unknown>): Promise<RuntimeToolResult>;
  ports: MCPExecutorPorts<TContext>;
}

/**
 * Create the Runtime-owned invocation guard for one captured MCP tool.
 * Connection ownership stays with Host; the executor retains that generation's
 * invoke callback and applies source approval against the current call context.
 */
export function createMCPToolExecutor<TContext extends object>(
  options: MCPToolExecutorOptions<TContext>,
): ToolExecutor<TContext, RuntimeToolResult> {
  const { toolName, source, invoke, ports } = options;
  const logger = ports.logger;

  const gateErrorResult = (
    gateKind: 'deny' | 'ask',
    message: string,
    reason?: 'authority_revoked',
  ): RuntimeToolResult & { metadata: { source: McpToolSource; gateKind: 'deny' | 'ask'; reason?: 'authority_revoked' } } => ({
    id: `${toolName}-gate`,
    name: toolName,
    result: message,
    error: true,
    metadata: { source, gateKind, ...(reason === undefined ? {} : { reason }) },
    });

  const guardedInvoke = async (
    context: TContext | undefined,
    input: Record<string, unknown>,
    executorRef: object,
  ): Promise<RuntimeToolResult> => {
    // Generation currency (W1 residual): an `ask` window can park this call
    // for minutes. If the live registry no longer points at THIS executor,
    // the captured invoke closure belongs to a replaced/removed generation.
    // Fail with the named gate error rather than executing stale — the routed
    // path's equivalent is #558's post-approval re-resolution.
    if (ports.isExecutorCurrent && !ports.isExecutorCurrent(toolName, executorRef)) {
      logger?.warn?.('[MCP] tool registration changed before execution; refusing stale generation', {
        toolName,
        source,
      }, 'MCP');
      return gateErrorResult(
        'deny',
        '[MCP permission gate] The tool registration changed before execution; re-dispatch the call.',
        'authority_revoked',
      );
    }
    if (context && ports.beforeInvoke) {
      let allowed = false;
      try { allowed = await ports.beforeInvoke(context, input); } catch { allowed = false; }
      if (!allowed) {
        return gateErrorResult(
          'deny',
          '[MCP permission gate] Invocation authority was revoked before execution.',
          'authority_revoked',
        );
      }
    }
    // Plan 616 T610b — establish the ambient app-tool context for the
    // duration of the call.
    //
    // An in-process MCP server (`duya_app`) runs its tool implementation
    // in THIS process, but the MCP wire carries only `name` +
    // `arguments` — the live `ToolUseContext` (host IPC function,
    // session id, per-turn state) cannot survive that boundary. The
    // ambient context is how the tool reaches it.
    //
    // The scope is established HERE, at the executor, because this is
    // the single point every MCP tool call passes through — including
    // the deferred path (`tool_invoke` → dispatcher → this executor).
    // AsyncLocalStorage keeps concurrent calls isolated, so two
    // in-flight tools never see each other's context.
    //
    // It wraps the INVOCATION, not the guard: `beforeInvoke` is a
    // host-side authority check that runs before the tool exists, so
    // it must not see the tool's ambient context.
    return withAppToolContext(context, () => invoke(input));
  };

  const executor: ToolExecutor<TContext, RuntimeToolResult> = {
    execute: async (input, _workingDirectory, context) => {
      const activeMode = context ? ports.getPermissionMode(context) : undefined;
      const decision = decideMcpSource(source, activeMode, toolName);
      // `undefined` means the provenance alone carries no verdict. That is
      // the app layer's answer (`source: 'app'`): it is first-party, but
      // NOT unconditional — the unified chain decides it, exactly as it
      // did before those tools moved behind the namespace.
      //
      // The unified chain HAS already run by the time this executor is
      // reached: the streaming executor calls `canUseTool` before it
      // executes a tool, and the deferred dispatcher checks permission
      // before it dispatches. So the correct behaviour here is to add no
      // verdict of our own — neither a second prompt nor a bypass.
      if (decision?.behavior === 'deny') {
        logger?.warn?.('[MCP] tool call denied by permission gate', {
          toolName,
          source,
          reason: decision.message,
        }, 'MCP');
        return gateErrorResult('deny', `[MCP permission gate] ${decision.message}`);
      }

      if (decision?.behavior === 'ask') {
        logger?.warn?.('[MCP] tool call requires user approval', {
          toolName,
          source,
          reason: decision.message,
        }, 'MCP');

        const toolUseId = context ? ports.getToolUseId(context) : undefined;
        const appState = context ? ports.getAppState(context) : undefined;
        const approvedToolUses = appState?._approvedToolUses as
          | Record<string, boolean>
          | undefined;
        if (!toolUseId || !approvedToolUses?.[toolUseId]) {
          if (!context || !ports.requestPermission) {
            const fallback = resolveAskWithoutUser(activeMode, toolName);
            if (fallback.behavior === 'deny') {
              logger?.warn?.('[MCP] ask-tool with no interactive user; denied', {
                toolName,
                source,
                mode: activeMode,
              }, 'MCP');
              return gateErrorResult('deny', `[MCP permission gate] ${fallback.message}`);
            }
            logger?.warn?.('[MCP] ask-tool with no interactive user; allowed by session mode', {
              toolName,
              source,
              mode: activeMode,
            }, 'MCP');
            return guardedInvoke(context, input, executor);
          }

          const userDecision = await ports.requestPermission(context, {
            id: toolUseId ?? globalThis.crypto.randomUUID(),
            toolName,
            toolInput: input,
            mode: 'generic',
            expiresAt: Date.now() + 5 * 60 * 1000,
            decisionReason: decision.message,
          });
          if (userDecision === undefined) {
            const fallback = resolveAskWithoutUser(activeMode, toolName);
            if (fallback.behavior === 'deny') {
              logger?.warn?.('[MCP] ask-tool with no interactive user; denied', {
                toolName,
                source,
                mode: activeMode,
              }, 'MCP');
              return gateErrorResult('deny', `[MCP permission gate] ${fallback.message}`);
            }
            logger?.warn?.('[MCP] ask-tool with no interactive user; allowed by session mode', {
              toolName,
              source,
              mode: activeMode,
            }, 'MCP');
            return guardedInvoke(context, input, executor);
          }
          if (userDecision === 'deny') {
            logger?.warn?.('[MCP] tool call denied by user', { toolName, source }, 'MCP');
            return gateErrorResult('ask', '[MCP permission gate] Permission denied by user');
          }
          if (userDecision === 'paused') {
            logger?.info?.('[MCP] tool call paused for durable approval card', {
              toolName,
              source,
            }, 'MCP');
            return gateErrorResult(
              'ask',
              'Waiting for user approval. The request has been sent as an approval card; ' +
                'end your turn without further tool calls.',
            );
          }

          if (toolUseId) {
            ports.setAppState?.(context, (previous) => ({
              ...previous,
              _approvedToolUses: {
                ...((previous._approvedToolUses as Record<string, boolean> | undefined) ?? {}),
                [toolUseId]: true,
              },
            }));
          }
        }
      }

      return guardedInvoke(context, input, executor);
    },
  };
  return executor;
}

import { randomUUID } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';

import type { ToolRegistry } from '../registry.js';
import type { ToolUseContext } from '../../types.js';
import type { ToolInvokeDispatcher, ToolInvokeRequest, ToolInvokeOutcome } from './ToolInvokeTool.js';
import type { ToolSnapshot } from '../snapshot.js';
import type { ToolCatalogEntry } from '../catalog-types.js';
import { logger } from '../../utils/logger.js';

/** Registry-backed fallback dispatcher. It resolves stable IDs against the
 * current catalog, validates the exact loaded schema revision, then follows
 * the ordinary permission and executor path. */

export interface ToolInvokePermissionDecision {
  behavior: 'allow' | 'deny' | 'ask';
  /** Deny / ask message when the decision carries one. */
  message?: string;
}

export interface ToolInvokeDispatcherDeps {
  /** Turn-level registry containing the tool surface. */
  registry: ToolRegistry;
  /** The exact immutable catalog view that the current request exposed. */
  getSnapshot?: () => ToolSnapshot | undefined;
  /** Schema detail reads scoped to this request/session. */
  getLoadedSchemaRevision?: (toolId: string) => string | undefined;
  /** Provider round in which each schema result became visible to the model. */
  getLoadedSchemaRound?: (toolId: string) => number | undefined;
  /** Current provider round, used to prevent same-response detail + invoke batches. */
  getCurrentRound?: () => number;
  /** Current-turn profile/mode/allowlist eligibility by stable tool ID. */
  isEligibleTool?: (toolId: string) => boolean;
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

const catalogAjv = new Ajv({ allErrors: true, strict: false });
const catalogValidators = new Map<string, ValidateFunction>();

function getCatalogValidator(entry: ToolCatalogEntry): ValidateFunction {
  const cached = catalogValidators.get(entry.schemaRevision);
  if (cached) return cached;
  const validator = catalogAjv.compile(entry.inputSchema);
  catalogValidators.set(entry.schemaRevision, validator);
  if (catalogValidators.size > 256) {
    const oldestKey = catalogValidators.keys().next().value;
    if (oldestKey !== undefined) catalogValidators.delete(oldestKey);
  }
  return validator;
}

function errorResult(title: string, body: string): ToolInvokeOutcome;
function errorResult(errorCode: string, title: string, body: string): ToolInvokeOutcome;
function errorResult(first: string, second: string, third?: string): ToolInvokeOutcome {
  if (third !== undefined) {
    return {
      result: `# ${second}\n\nError code: \`${first}\`\n\n${third}`,
      error: true,
      errorCode: first,
    };
  }
  return { result: `# ${first}\n\n${second}`, error: true };
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
      const { tool_id: toolId, arguments: args } = request;
      const snapshot = deps.getSnapshot?.();
      const advertised = snapshot?.getCatalogEntry(toolId);
      if (!advertised) {
        return errorResult('TOOL_NOT_FOUND', 'Tool not found', `No tool with stable ID \`${toolId}\` exists in the current catalog snapshot.`);
      }
      if (advertised.exposure === 'hidden') {
        return errorResult('TOOL_HIDDEN', 'Tool unavailable', `Tool \`${toolId}\` is hidden.`);
      }
      if (deps.isEligibleTool && !deps.isEligibleTool(toolId)) {
        return errorResult('TOOL_OUT_OF_SCOPE', 'Tool unavailable', `Tool \`${toolId}\` is outside the active profile or mode scope.`);
      }
      if (advertised.exposure !== 'deferred') {
        return errorResult('TOOL_IS_EAGER', 'Tool is already available', `Call \`${advertised.definition.name}\` directly; eager tools cannot be dispatched through tool_invoke.`);
      }

      // Resolve again against the live registry before permission checks so a
      // mid-turn tools/list_changed cannot execute stale arguments.
      const current = deps.registry.getCatalogEntryById(toolId);
      if (!current) {
        return errorResult('TOOL_NOT_FOUND', 'Tool no longer available', `Tool \`${toolId}\` was removed from the live registry.`);
      }
      if (current.exposure === 'hidden') {
        return errorResult('TOOL_HIDDEN', 'Tool unavailable', `Tool \`${toolId}\` is now hidden.`);
      }
      if (current.exposure !== 'deferred') {
        return errorResult('TOOL_IS_EAGER', 'Tool exposure changed', `Tool \`${toolId}\` is no longer deferred. Call \`${current.definition.name}\` directly.`);
      }
      // Validate against the live schema before permission checks and execution.
      // A catalog detail read is optional: valid arguments can be dispatched
      // immediately, and schema changes are handled by live validation.
      try {
        const validate = getCatalogValidator(current);
        if (!validate(args)) {
          const issues = (validate.errors ?? [])
            .slice(0, 8)
            .map((issue) => `${issue.instancePath || '/'} ${issue.message ?? 'is invalid'}`);
          return errorResult('INVALID_ARGUMENTS', 'Invalid tool arguments', issues.join('\n') || 'Arguments do not match the current tool schema.');
        }
      } catch (error) {
        return errorResult('INVALID_SCHEMA', 'Tool schema cannot be validated', error instanceof Error ? error.message : String(error));
      }

      const decision = await deps.checkPermission(current.internalName, args);
      if (decision.behavior === 'deny') {
        return errorResult(
          'TOOL_PERMISSION_DENIED',
          'Permission denied',
          decision.message ?? `The tool \`${current.definition.name}\` was denied by the permission policy.`,
        );
      }
      if (decision.behavior === 'ask') {
        const context = deps.contextProvider?.();
        if (context?.requestPermission) {
          const userDecision = await context.requestPermission({
            id: randomUUID(),
            toolName: current.internalName,
            toolInput: args,
            mode: 'generic',
            expiresAt: Date.now() + 5 * 60 * 1000,
            decisionReason: decision.message,
          });
          if (userDecision === 'deny') {
            logger.warn('[ToolInvoke] tool call denied by user', { toolName: current.internalName, toolId });
            return errorResult(
              'TOOL_PERMISSION_DENIED',
              'Permission denied',
              decision.message ?? `The user denied the call to \`${current.definition.name}\`.`,
            );
          }
          if (userDecision === 'paused') {
            logger.info('[ToolInvoke] tool call paused for durable approval card', { toolName: current.internalName, toolId });
            return errorResult(
              'TOOL_APPROVAL_PENDING',
              'Waiting for approval',
              `The call to \`${current.definition.name}\` is waiting for user approval. The request has been sent as an approval card; end your turn without further tool calls.`,
            );
          }
        } else {
          logger.warn(
            '[ToolInvoke] no interactive user available; implicitly allowing ask-tool',
            { toolName: current.internalName, toolId, reason: decision.message },
          );
        }
      }

      try {
        const executor = current.executor;
        const isMcp = deps.registry.getOwner(current.definition.name) === 'mcp';
        const result = await executor.execute(
          args,
          deps.workingDirectory,
          isMcp ? undefined : deps.contextProvider?.(),
        );
        const resultText = result && typeof result === 'object'
          ? toText((result as { result?: unknown }).result)
          : toText(result);
        const isError = (result as { error?: boolean } | null)?.error === true;
        // Plan 580 D8: preserve the canonical MCP blocks/structured from
        // the deferred tool's ToolResult (lossless save; the text already
        // carries the bounded metadata lines).
        const blocks = (result as { blocks?: unknown[] } | null)?.blocks;
        const structured = (result as { structured?: unknown } | null)?.structured;
        return {
          result: resultText ?? `Tool \`${current.definition.name}\` returned no result.`,
          toolName: current.definition.name,
          ...(isError ? { error: true } : {}),
          ...(blocks ? { blocks } : {}),
          ...(structured !== undefined ? { structured } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult('TOOL_EXECUTION_FAILED', 'Tool Invoke Failed', `Invoking \`${current.definition.name}\` failed:\n\n${message}`);
      }
    },
  };
}

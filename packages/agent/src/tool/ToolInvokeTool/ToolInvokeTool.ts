import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

/**
 * Plan 480 P2.1 — `tool_invoke` invocation meta tool.
 *
 * Invokes a deferred tool that is NOT in the request's `tools` array. The
 * model may read the target's schema via `tool_catalog` when it needs discovery
 * or argument guidance, then calls this tool with `{ tool_id, arguments }`.
 * The executor validates against the live schema before dispatching.
 *
 * This module deliberately contains NO registry/permission logic: the
 * injected `ToolInvokeDispatcher` is the seam where the agent wires
 * resolution → permission gate (Plan 480 §8.3 / P2.2) → real executor →
 * timeout-by-real-name. Unit tests exercise the tool body with a fake
 * dispatcher; the permission/harness logic lands with the real wiring.
 */

export const TOOL_INVOKE_NAME = 'tool_invoke';
export const TOOL_INVOKE_RESULT_MARKER = '<!-- duya-tool-invoke-result -->';

export interface ToolInvokeRequest {
  tool_id: string;
  arguments: Record<string, unknown>;
}

/** Outcome surfaced back to the model as a tool_result. */
export interface ToolInvokeOutcome {
  result: string;
  error?: boolean;
  errorCode?: string;
  toolName?: string;
  /**
   * Plan 580 D8: canonical MCP content blocks preserved from the
   * deferred tool's ToolResult (lossless save; the text already carries
   * bounded metadata lines).
   */
  blocks?: unknown[];
  /** Plan 580 D8: verbatim `structuredContent` from the MCP result. */
  structured?: unknown;
}

export interface ToolInvokeDispatcher {
  dispatch(request: ToolInvokeRequest): Promise<ToolInvokeOutcome>;
}

const DESCRIPTION = `Invoke a deferred tool that is not in the current tool list.

Use \`tool_catalog\` to discover tools or inspect a schema when needed. If you already know the stable \`tool_id\` and valid arguments, invoke it directly; the arguments are checked against the current schema before execution:

\`{"tool_id":"<stable-id>","arguments":{...}}\`

The result is returned as if the tool had been called directly. Errors from the underlying tool (including permission denials) are returned in the result — do not retry blindly; read the error and adjust.`;

export class ToolInvokeTool implements Tool, ToolExecutor {
  readonly name = TOOL_INVOKE_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      tool_id: {
        type: 'string',
        description: 'Stable tool ID returned by tool_catalog',
      },
      arguments: {
        type: 'object',
        description: 'Arguments for the deferred tool; validated against its current schema before execution.',
      },
    },
    required: ['tool_id', 'arguments'],
    additionalProperties: false,
  };

  private dispatcher?: ToolInvokeDispatcher;
  // StreamingToolExecutor creates a shallow per-tool context copy. The
  // options object keeps the per-turn identity across that copy.
  private readonly contextDispatchers = new WeakMap<object, ToolInvokeDispatcher>();

  setDispatcher(dispatcher: ToolInvokeDispatcher): void {
    this.dispatcher = dispatcher;
  }

  setDispatcherForContext(context: ToolUseContext, dispatcher: ToolInvokeDispatcher): void {
    this.contextDispatchers.set(context, dispatcher);
    if (context.options && typeof context.options === 'object') {
      this.contextDispatchers.set(context.options, dispatcher);
    }
  }

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    } as Tool;
  }

  private errorResult(title: string, body: string): ToolResult {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: `${TOOL_INVOKE_RESULT_MARKER}\n\n# ${title}\n\n${body}`,
      error: true,
    };
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    const toolId = typeof input.tool_id === 'string' ? input.tool_id.trim() : undefined;
    const args = input.arguments;

    if (!toolId) {
      return this.errorResult('Tool Invoke Error', '`tool_id` (string) is required.');
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return this.errorResult(
        'Tool Invoke Error',
        '`arguments` must be an object. Use `tool_catalog` to inspect the schema if you need help with its fields.',
      );
    }

    const dispatcher = context
      ? this.contextDispatchers.get(context) ??
        (context.options ? this.contextDispatchers.get(context.options) : undefined)
      : this.dispatcher;
    if (!dispatcher) {
      return this.errorResult(
        'Tool Invoke Error',
        'Tool invocation is not configured in this session.',
      );
    }

    try {
      const outcome = await dispatcher.dispatch({
        tool_id: toolId,
        arguments: args as Record<string, unknown>,
      });
      const isError = outcome.error === true;
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result:
          outcome.result ??
          `${TOOL_INVOKE_RESULT_MARKER}\n\n# Tool Invoke: \`${toolId}\`\n\n_No result returned._`,
        ...(outcome.errorCode ? { metadata: { errorCode: outcome.errorCode } } : {}),
        ...(isError ? { error: true } : {}),
        // Plan 580 D8: pass the canonical MCP blocks through untouched.
        ...(outcome.blocks ? { blocks: outcome.blocks } : {}),
        ...(outcome.structured !== undefined ? { structured: outcome.structured } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(
        'Tool Invoke Failed',
        `Invoking \`${toolId}\` failed:\n\n${message}`,
      );
    }
  }
}

export const toolInvokeTool = new ToolInvokeTool();

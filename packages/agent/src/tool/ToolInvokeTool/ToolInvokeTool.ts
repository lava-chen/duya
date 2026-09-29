import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

/**
 * Plan 480 P2.1 — `tool_invoke` invocation meta tool.
 *
 * Invokes a tool that is NOT in the request's `tools` array. The model must
 * first read the target's schema via `tool_catalog`, then call this tool with
 * `{ namespace, tool, arguments }`. The executor resolves the real tool and
 * dispatches through the injected handler.
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
}

export interface ToolInvokeDispatcher {
  dispatch(request: ToolInvokeRequest): Promise<ToolInvokeOutcome>;
}

const DESCRIPTION = `Invoke a tool that is not in the current tool list.

Call \`tool_catalog\` with the target \`tool_id\` FIRST to read its current schema, then invoke it here:

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
        description:
          'Arguments for the tool, matching the current schema returned by tool_catalog',
      },
    },
    required: ['tool_id', 'arguments'],
    additionalProperties: false,
  };

  private dispatcher?: ToolInvokeDispatcher;
  private readonly contextDispatchers = new WeakMap<ToolUseContext, ToolInvokeDispatcher>();

  setDispatcher(dispatcher: ToolInvokeDispatcher): void {
    this.dispatcher = dispatcher;
  }

  setDispatcherForContext(context: ToolUseContext, dispatcher: ToolInvokeDispatcher): void {
    this.contextDispatchers.set(context, dispatcher);
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
        '`arguments` (object) is required. Read the schema with `tool_catalog` first.',
      );
    }

    const dispatcher = context ? this.contextDispatchers.get(context) : this.dispatcher;
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

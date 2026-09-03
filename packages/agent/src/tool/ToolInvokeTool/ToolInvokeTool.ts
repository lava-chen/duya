import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

/**
 * Plan 480 P2.1 — `tool_invoke` invocation meta tool.
 *
 * Invokes a tool that is NOT in the request's `tools` array. The model must
 * first read the target's schema via `tool_schema`, then call this tool with
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
  namespace: string;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Outcome surfaced back to the model as a tool_result. */
export interface ToolInvokeOutcome {
  result: string;
  error?: boolean;
}

export interface ToolInvokeDispatcher {
  dispatch(request: ToolInvokeRequest): Promise<ToolInvokeOutcome>;
}

const DESCRIPTION = `Invoke a tool that is not in the current tool list.

Call \`tool_schema\` FIRST to read the target tool's schema, then invoke it here:

\`{"namespace":"<id>","tool":"<name>","arguments":{...}}\`

The result is returned as if the tool had been called directly. Errors from the underlying tool (including permission denials) are returned in the result — do not retry blindly; read the error and adjust.`;

export class ToolInvokeTool implements Tool, ToolExecutor {
  readonly name = TOOL_INVOKE_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace of the tool (e.g. an MCP server name)',
      },
      tool: {
        type: 'string',
        description: 'Name of the tool to invoke',
      },
      arguments: {
        type: 'object',
        description:
          'Arguments for the tool, matching the schema returned by tool_schema',
      },
    },
    required: ['namespace', 'tool', 'arguments'],
  };

  private dispatcher?: ToolInvokeDispatcher;

  setDispatcher(dispatcher: ToolInvokeDispatcher): void {
    this.dispatcher = dispatcher;
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

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const namespace = typeof input.namespace === 'string' ? input.namespace : undefined;
    const tool = typeof input.tool === 'string' ? input.tool : undefined;
    const args = input.arguments;

    if (!namespace) {
      return this.errorResult('Tool Invoke Error', '`namespace` (string) is required.');
    }
    if (!tool) {
      return this.errorResult('Tool Invoke Error', '`tool` (string) is required.');
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      return this.errorResult(
        'Tool Invoke Error',
        '`arguments` (object) is required. Read the schema with `tool_schema` first.',
      );
    }

    if (!this.dispatcher) {
      return this.errorResult(
        'Tool Invoke Error',
        'Tool invocation is not configured in this session.',
      );
    }

    try {
      const outcome = await this.dispatcher.dispatch({
        namespace,
        tool,
        arguments: args as Record<string, unknown>,
      });
      const isError = outcome.error === true;
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result:
          outcome.result ??
          `${TOOL_INVOKE_RESULT_MARKER}\n\n# Tool Invoke: \`${namespace}\` / \`${tool}\`\n\n_No result returned._`,
        ...(isError ? { error: true } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(
        'Tool Invoke Failed',
        `Invoking \`${tool}\` in namespace \`${namespace}\` failed:\n\n${message}`,
      );
    }
  }
}

export const toolInvokeTool = new ToolInvokeTool();

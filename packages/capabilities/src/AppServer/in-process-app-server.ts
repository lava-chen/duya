/**
 * `duya_app` — the host-owned, in-process MCP server (plan 616).
 *
 * ## Why an in-process server
 *
 * The product capabilities duya wants in one place (bot
 * channels, the browser) are **implemented in this process**: their
 * executors reach the host over an in-process IPC function
 * (`context.ipcRequest`) and read per-turn state,
 * the session id, the abort controller).
 *
 * A subprocess MCP server cannot carry that state across the process
 * boundary — it would have to be serialized into the tool arguments, which
 * is neither possible (functions) nor desirable (per-turn state is not a
 * tool argument). So the server is built **in-process** and the MCP client
 * connects to it over a linked in-memory transport pair.
 *
 * ## What this buys
 *
 * The server speaks the ordinary MCP contract (`tools/list`, `tools/call`),
 * so the host-owned capabilities reach the model through the SAME pipeline
 * every external MCP server uses:
 *
 *   - the internal key `mcp__duya_app__<tool>` and the model-visible name
 *     `mcp_duya_app_<tool>` come from the shared allocator;
 *   - the catalog (`tool_catalog`) and the deferred dispatch
 *     (`tool_invoke`) treat them like any other discovered tool;
 *   - the schema byte budget and the permission gate apply unchanged.
 *
 * Codex reaches the same shape through a *remote* `codex_apps` server
 * (`codex-rs/core/src/mcp.rs:249`); the difference is that duya's app
 * capabilities are local, so the server is local too.
 *
 * ## Tool execution context (plan 616 T610b)
 *
 * `tools/call` carries only `name` + `arguments` — never the live
 * `ToolUseContext`. The pipeline that carries it is AsyncLocalStorage:
 * the caller wraps the call in `als.run(context, …)` and the server side
 * reads `als.getStore()`. AsyncLocalStorage propagates across `await` and
 * keeps concurrent calls isolated, which was verified before this module
 * was written (plan 616 §C8).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { InProcessMcpServer } from '../MCP/ports.js';
import type { ToolResult } from '@duya/ai';
import { currentAppToolContext, type AppToolContext } from './app-tool-context.js';

/** One tool advertised by the app server. */
export interface AppServerToolDefinition {
  /** Wire name — the same name the model would see without the namespace. */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * A tool the app server can EXECUTE, not just advertise.
 *
 * The executor is the capability's own — the same object the tool would
 * have been registered with directly. It receives the live host context
 * (see `app-tool-context.ts`), so an app tool keeps full access to the
 * host IPC, the session, and the per-turn state.
 */
export interface AppServerTool extends AppServerToolDefinition {
  /**
   * Run the tool. `context` is the ambient host context, or `undefined`
   * when the call did not come from a turn.
   */
  execute(input: Record<string, unknown>, context: AppToolContext | undefined): Promise<ToolResult>;
}

export interface InProcessAppServerOptions {
  /** Server name; also the namespace segment of every tool's internal key. */
  name: string;
  version?: string;
  tools: readonly AppServerTool[];
}

/**
 * The app server instance.
 *
 * `connect` / `close` mirror the MCP SDK `Server` surface so the client
 * treats it exactly like a remote server.
 */
export interface InProcessAppServer extends InProcessMcpServer {
  readonly server: Server;
}

/**
 * Build the `duya_app` MCP server.
 *
 * `tools/list` advertises the tools; `tools/call` executes one. The
 * executor runs inside the ambient app-tool context, so it can reach the
 * host IPC and the per-turn state exactly as a directly-registered
 * capability tool would.
 */
export function createInProcessAppServer(options: InProcessAppServerOptions): InProcessAppServer {
  const server = new Server(
    { name: options.name, version: options.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const toolsByName = new Map(options.tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    // The ambient context is the host's live ToolUseContext. It is
    // undefined when the call did not come from a turn — the tool must
    // degrade gracefully rather than crash.
    const context = currentAppToolContext();
    const result = await tool.execute(request.params.arguments ?? {}, context);

    return {
      content: [{ type: 'text', text: result.result }],
      ...(result.error ? { isError: true } : {}),
      // The result metadata rides along so the renderer can build rich
      // tool rows (browser results, CUA app info, vision previews)
      // without parsing the text. The MCP result schema is loose, so
      // this survives the round trip.
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.structured !== undefined ? { structuredContent: result.structured } : {}),
    };
  });

  return {
    server,
    connect: (transport: unknown) => server.connect(transport as never),
    close: () => server.close(),
  };
}

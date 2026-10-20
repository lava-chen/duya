/**
 * `duya_app` — the host-owned, in-process MCP server (plan 616).
 *
 * ## Why an in-process server
 *
 * The product capabilities duya wants in one place (canvas, the bot
 * channels, the browser) are **implemented in this process**: their
 * executors reach the host over an in-process IPC function
 * (`context.ipcRequest`) and read per-turn state (the bound canvas id,
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
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { InProcessMcpServer } from '../MCP/ports.js';

/** One tool advertised by the app server. */
export interface AppServerToolDefinition {
  /** Wire name — the same name the model would see without the namespace. */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

export interface InProcessAppServerOptions {
  /** Server name; also the namespace segment of every tool's internal key. */
  name: string;
  version?: string;
  tools: readonly AppServerToolDefinition[];
}

/**
 * The app server instance.
 *
 * `connect` / `close` mirror the MCP SDK `Server` surface so the client
 * treats it exactly like a remote server; `server` is exposed for the
 * advanced wiring (the `tools/call` handler lands in T610b).
 */
export interface InProcessAppServer extends InProcessMcpServer {
  readonly server: Server;
}

/**
 * Build the `duya_app` MCP server.
 *
 * Only `tools/list` is wired here — the skeleton. `tools/call` is added
 * in T610b together with the context pipeline; until then the server
 * advertises its tools but cannot execute them.
 */
export function createInProcessAppServer(options: InProcessAppServerOptions): InProcessAppServer {
  const server = new Server(
    { name: options.name, version: options.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
    })),
  }));

  return {
    server,
    connect: (transport: unknown) => server.connect(transport as never),
    close: () => server.close(),
  };
}

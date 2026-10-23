/**
 * Plan 616 T610b — the context pipeline for the in-process app server.
 *
 * ## The problem
 *
 * MCP `tools/call` carries only `name` + `arguments`. The product
 * capabilities that will live in `duya_app` need the LIVE host context:
 *
 *   - `ipcRequest` — a FUNCTION that reaches the main process;
 *   - `options.sessionId` — which session is calling;
 *   - `toolUseContext` extension fields — per-turn host binding;
 *   - `abortController` — so a cancelled turn cancels the tool.
 *
 * None of that survives a JSON boundary, and none of it belongs in the
 * tool's arguments (it is not a model-supplied value).
 *
 * ## The mechanism
 *
 * AsyncLocalStorage. The caller wraps the call in `als.run(context, …)`
 * and the server side reads `als.getStore()`. ALS propagates across
 * `await` and keeps concurrent calls isolated — both verified before
 * this file was written (plan 616 §C8).
 *
 * The alternative (`params._meta` smuggling a live object) also works
 * but puts a host-private object into a public protocol field that
 * every MCP server would see.
 *
 * ## What this pins
 *
 * 1. The server side of a `duya_app` call can read the host context.
 * 2. Concurrent calls each see their OWN context (no cross-talk).
 * 3. A call made OUTSIDE any context sees no context (and the tool
 *    must degrade gracefully rather than crash).
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCPManager } from '../../src/MCP/MCPManager.js';
import type { MCPServerConfig } from '../../src/MCP/ports.js';
import {
  withAppToolContext,
  currentAppToolContext,
  type AppToolContext,
} from '../../src/AppServer/app-tool-context.js';
import { createInProcessAppServer } from '../../src/AppServer/in-process-app-server.js';

interface ProbeContext extends AppToolContext {
  readonly tag: string;
  readonly ipcRequest: (channel: string) => Promise<string>;
}

/**
 * A server whose single tool reports what it can see of the caller.
 * Mirrors the shape a real `duya_app` tool has: it needs the host
 * context to do its work.
 */
function makeProbingServer() {
  const server = new Server(
    { name: 'duya_app', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'probe',
        description: 'Reports what the caller context looks like.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    const context = currentAppToolContext<ProbeContext>();
    if (!context) {
      return { content: [{ type: 'text', text: 'NO_CONTEXT' }] };
    }
    const echoed = await context.ipcRequest('app:host-rpc');
    return {
      content: [
        { type: 'text', text: `${context.tag}|${context.options?.sessionId ?? ''}|${echoed}` },
      ],
    };
  });
  return server;
}

async function callWithContext(
  manager: MCPManager,
  context: ProbeContext | undefined,
  toolName = 'probe',
): Promise<string> {
  const client = manager.getClient('duya_app');
  const result = await client!.callTool(toolName, {});
  return result.result;
}

describe('plan 616 T610b — in-process app server context pipeline', () => {
  it('the server side of a duya_app call can read the live host context', async () => {
    const manager = new MCPManager();
    const server = makeProbingServer();

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const context: ProbeContext = {
      tag: 'ctx-A',
      sessionId: 'sess-1',
      options: { sessionId: 'sess-1' },
      ipcRequest: async (channel: string) => `ipc:${channel}`,
    };

    const text = await withAppToolContext(context, () => callWithContext(manager, context));

    expect(text).toBe('ctx-A|sess-1|ipc:app:host-rpc');
    await manager.disconnectAll();
  });

  it('concurrent calls each see their own context', async () => {
    const manager = new MCPManager();
    const server = makeProbingServer();

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const tags = ['A', 'B', 'C', 'D', 'E'];
    const results = await Promise.all(
      tags.map((tag) => {
        const context: ProbeContext = {
          tag,
          sessionId: `sess-${tag}`,
          options: { sessionId: `sess-${tag}` },
          ipcRequest: async (channel: string) => `ipc:${tag}:${channel}`,
        };
        return withAppToolContext(context, () => callWithContext(manager, context));
      }),
    );

    // Each call must observe its OWN context — no cross-talk, and the
    // order need not match because the calls interleave.
    const observed = new Set(results.map((r) => r.split('|')[0]));
    expect(observed).toEqual(new Set(tags));
    for (const result of results) {
      const [tag, sessionId] = result.split('|');
      expect(sessionId).toBe(`sess-${tag}`);
      expect(result).toContain(`ipc:${tag}:`);
    }

    await manager.disconnectAll();
  });

  it('a call made outside any context sees no context and does not crash', async () => {
    const manager = new MCPManager();
    const server = makeProbingServer();

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const text = await callWithContext(manager, undefined);
    expect(text).toBe('NO_CONTEXT');

    await manager.disconnectAll();
  });

  it('the context survives an await inside the tool implementation', async () => {
    const manager = new MCPManager();
    const server = new Server(
      { name: 'duya_app', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'probe',
          description: 'Reports the context before and after an await.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const before = currentAppToolContext<ProbeContext>()?.tag;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const after = currentAppToolContext<ProbeContext>()?.tag;
      return { content: [{ type: 'text', text: `${before}->${after}` }] };
    });

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const context: ProbeContext = {
      tag: 'ctx-A',
      sessionId: 'sess-1',
      options: { sessionId: 'sess-1' },
      ipcRequest: async () => '',
    };
    const text = await withAppToolContext(context, () => callWithContext(manager, context));

    expect(text).toBe('ctx-A->ctx-A');
    await manager.disconnectAll();
  });

  it('the app server executes a capability tool with the live context', async () => {
    // The real shape: a capability tool implementation, registered on the
    // app server, running with the host context — the same contract a
    // directly-registered capability tool has today.
    const manager = new MCPManager();
    const server = createInProcessAppServer({
      name: 'duya_app',
      tools: [
        {
          name: 'context_probe',
          description: 'Reads the live host context.',
          inputSchema: { type: 'object', properties: {} },
          execute: async (_input, context) => {
            const probe = context as ProbeContext | undefined;
            if (!probe) {
              return { id: 'x', name: 'context_probe', result: 'NO_CONTEXT', error: true };
            }
            const echoed = await probe.ipcRequest('app:host-rpc');
            return {
              id: 'x',
              name: 'context_probe',
              result: `${probe.tag}|${probe.options?.sessionId ?? ''}|${echoed}`,
              metadata: { probeMeta: true },
            };
          },
        },
      ],
    });

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const context: ProbeContext = {
      tag: 'ctx-A',
      sessionId: 'sess-1',
      options: { sessionId: 'sess-1' },
      ipcRequest: async (channel: string) => `ipc:${channel}`,
    };
    const text = await withAppToolContext(context, () =>
      callWithContext(manager, context, 'context_probe'),
    );

    expect(text).toBe('ctx-A|sess-1|ipc:app:host-rpc');
    await manager.disconnectAll();
  });

  it('the app server preserves the tool result metadata across the MCP round trip', async () => {
    // The renderer builds rich rows (browser results, CUA app info,
    // vision previews) from `tool.metadata`. If the round trip dropped
    // it, every migrated tool would lose its rich rendering.
    const manager = new MCPManager();
    const server = createInProcessAppServer({
      name: 'duya_app',
      tools: [
        {
          name: 'with_meta',
          description: 'Returns metadata.',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => ({
            id: 'x',
            name: 'with_meta',
            result: 'done',
            metadata: { browserResults: [{ title: 'example' }] },
          }),
        },
      ],
    });

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const client = manager.getClient('duya_app');
    const result = await client!.callTool('with_meta', {});

    expect(result.result).toBe('done');
    expect(result.metadata).toEqual({ browserResults: [{ title: 'example' }] });

    await manager.disconnectAll();
  });
});

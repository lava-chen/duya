/**
 * Plan 616 T610b — the production context pipeline.
 *
 * `packages/capabilities/tests/mcp/in-process-app-context.test.ts` pins the
 * MECHANISM (AsyncLocalStorage carries a context across an in-process MCP
 * call, and concurrent calls stay isolated). This file pins the PRODUCTION
 * WIRING: the Runtime's MCP executor establishes the ambient scope, so an
 * in-process app server's tool implementation reads the live host context
 * without the protocol carrying it.
 *
 * The seam that matters: EVERY MCP tool call — eager or deferred
 * (`tool_invoke` → dispatcher → executor) — passes through
 * `createMCPToolExecutor`. That is the one place the scope can be
 * established, so it is the one place that establishes it.
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createMCPToolExecutor } from '../../../src/tools/mcp-executor.js';
import { currentAppToolContext } from '@duya/capabilities/AppServer/app-tool-context';

interface HostContext {
  readonly tag: string;
  readonly ipcRequest: (channel: string) => Promise<string>;
  readonly options?: { sessionId?: string };
}

describe('plan 616 T610b — the MCP executor establishes the app-tool context', () => {
  it('an in-process app server tool reads the live host context', async () => {
    const server = new Server(
      { name: 'duya_app', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'probe',
          description: 'Reports the caller context.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      const context = currentAppToolContext<HostContext>();
      if (!context) return { content: [{ type: 'text', text: 'NO_CONTEXT' }] };
      const echoed = await context.ipcRequest('conductor:executor:rpc');
      return {
        content: [{ type: 'text', text: `${context.tag}|${context.options?.sessionId ?? ''}|${echoed}` }],
      };
    });

    const [clientTransport, serverTransport] = (
      await import('@modelcontextprotocol/sdk/inMemory.js')
    ).InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const executor = createMCPToolExecutor<HostContext>({
      toolName: 'probe',
      source: 'bundled',
      invoke: async (input) => {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
        const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
        await client.connect(clientTransport);
        const result = await client.callTool(
          { name: 'probe', arguments: input },
          CallToolResultSchema,
        );
        const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
        return { id: 'probe', name: 'probe', result: text };
      },
      ports: {
        getToolUseId: () => 'tool-1',
        getPermissionMode: () => 'default',
        getAppState: () => ({}),
      },
    });

    const context: HostContext = {
      tag: 'ctx-A',
      sessionId: 'sess-1',
      options: { sessionId: 'sess-1' },
      ipcRequest: async (channel: string) => `ipc:${channel}`,
    };

    const result = await executor.execute({}, undefined, context);

    expect(result?.result).toBe('ctx-A|sess-1|ipc:conductor:executor:rpc');
  });

  it('concurrent MCP tool calls do not see each other\'s context', async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');

    // One server + one client per call: the SDK refuses to reconnect a
    // Protocol instance, and what is under test is the CONTEXT isolation
    // between concurrent calls, not connection reuse.
    const makeExecutor = async () => {
      const server = new Server(
        { name: 'duya_app', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'probe',
            description: 'Reports the caller context.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => {
        const before = currentAppToolContext<HostContext>()?.tag;
        await new Promise((resolve) => setTimeout(resolve, 5));
        const after = currentAppToolContext<HostContext>()?.tag;
        return { content: [{ type: 'text', text: `${before}->${after}` }] };
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
      await client.connect(clientTransport);

      return createMCPToolExecutor<HostContext>({
        toolName: 'probe',
        source: 'bundled',
        invoke: async (input) => {
          const result = await client.callTool(
            { name: 'probe', arguments: input },
            CallToolResultSchema,
          );
          const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
          return { id: 'probe', name: 'probe', result: text };
        },
        ports: {
          getToolUseId: () => 'tool-1',
          getPermissionMode: () => 'default',
          getAppState: () => ({}),
        },
      });
    };

    const tags = ['A', 'B', 'C', 'D', 'E'];
    const results = await Promise.all(
      tags.map(async (tag) => {
        const executor = await makeExecutor();
        const context: HostContext = {
          tag,
          sessionId: `sess-${tag}`,
          options: { sessionId: `sess-${tag}` },
          ipcRequest: async () => '',
        };
        const result = await executor.execute({}, undefined, context);
        return result?.result ?? '';
      }),
    );

    for (const tag of tags) {
      expect(results).toContain(`${tag}->${tag}`);
    }
  });
});

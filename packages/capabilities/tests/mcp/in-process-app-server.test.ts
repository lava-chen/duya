/**
 * Plan 616 T610a — `duya_app` 进程内 MCP server 骨架.
 *
 * `duya_app` 是 host-owned 的**进程内** MCP server：它不 spawn 子进程，
 * 而是与 MCP client 共享同一个进程，因此工具执行时能读到活的宿主上下文
 * （见 T610b 的 AsyncLocalStorage 管道）。
 *
 * 本卡只交付骨架，不迁任何工具：
 *   1. `MCPServerConfig.transport` 能表达「进程内」这一形态；
 *   2. `MCPManager` 能把一个进程内 server 接进来并完成 `tools/list`；
 *   3. 该 server 的工具在模型侧拿到 `mcp__duya_app__<tool>` 内部键与
 *      `mcp_duya_app_<tool>` 模型可见名（与真实 MCP server 同一套规则）。
 *
 * 失败证据（本文件存在即红）：
 *   - `MCPServerConfig.transport` 的类型只有 `'stdio' | 'streamable-http'`，
 *     写 `'in-process'` 编译期即红；
 *   - `MCPManager` 没有接入进程内 server 的入口，工具列表为空。
 */

import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { MCPManager } from '../../src/MCP/MCPManager.js';
import type { MCPServerConfig } from '../../src/MCP/ports.js';
import { createInProcessAppServer } from '../../src/AppServer/in-process-app-server.js';
import { computeProviderName, AnthropicToolNamePolicy } from '@duya/plugin-core';

function makeInProcessServer(toolNames: string[]): Server {
  const server = new Server(
    { name: 'duya_app', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolNames.map((name) => ({
      name,
      description: `duya_app tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
    })),
  }));
  return server;
}

describe('plan 616 T610a — duya_app in-process MCP server', () => {
  it("MCPServerConfig can express the 'in-process' transport", () => {
    // The type-level assertion is the point: today `transport` is
    // `'stdio' | 'streamable-http'` and this line does not compile.
    const config: MCPServerConfig = {
      name: 'duya_app',
      transport: 'in-process',
    };
    expect(config.transport).toBe('in-process');
  });

  it('MCPManager connects to an in-process server and lists its tools', async () => {
    const manager = new MCPManager();
    const server = makeInProcessServer(['save_note', 'send_message']);

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      // The in-process server instance is handed to the manager; the
      // manager owns the client side of the transport pair.
      inProcessServer: server,
    } as MCPServerConfig);

    const client = manager.getClient('duya_app');
    expect(client).toBeDefined();
    expect(client!.isConnected()).toBe(true);
    expect(client!.getTools().map((t) => t.name).sort()).toEqual([
      'save_note',
      'send_message',
    ]);

    await manager.disconnectAll();
  });

  it('in-process tools get the same internal key / provider name as a real MCP server', async () => {
    const manager = new MCPManager();
    const server = makeInProcessServer(['save_note']);

    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    // The REAL production allocator (packages/plugin-core/src/mcp/
    // provider-tool-name.ts), not a hand-rolled stand-in — the naming
    // contract is exactly what the model sees.
    const used = new Set<string>();
    const tools = manager.getAllToolsWithIdentity((internalKey, nameOverride) => {
      const name = computeProviderName(internalKey, used, AnthropicToolNamePolicy, nameOverride);
      used.add(name);
      return name;
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].internalKey).toBe('mcp__duya_app__save_note');
    expect(tools[0].name).toBe('mcp_duya_app_save_note');
    expect(tools[0].mcpInfo?.serverName).toBe('duya_app');
    expect(tools[0].mcpInfo?.toolName).toBe('save_note');

    await manager.disconnectAll();
  });

  it('the app server helper builds a server that speaks MCP tools/list', async () => {
    const server = createInProcessAppServer({
      name: 'duya_app',
      tools: [
        {
          name: 'save_note',
          description: 'Save a note in the current session.',
          inputSchema: {
            type: 'object',
            properties: { action: { type: 'string', enum: ['save'] } },
            required: ['action'],
          },
        },
      ],
    });

    const manager = new MCPManager();
    await manager.addServer({
      name: 'duya_app',
      transport: 'in-process',
      source: 'bundled',
      inProcessServer: server,
    } as MCPServerConfig);

    const client = manager.getClient('duya_app');
    expect(client!.getTools().map((t) => t.name)).toEqual(['save_note']);
    expect(client!.getTools()[0].input_schema).toMatchObject({
      type: 'object',
      required: ['action'],
    });

    await manager.disconnectAll();
  });

  it('two different in-process servers do NOT share a config signature', () => {
    // The reload path reuses a client when the signature matches. If two
    // distinct app servers looked identical, a reload would keep the old
    // client (and its old transport pair) pointed at a discarded server.
    const first = makeInProcessServer(['save_note']);
    const second = makeInProcessServer(['save_note']);

    const signatureOf = (server: Server) =>
      MCPManager.configSignature({
        name: 'duya_app',
        transport: 'in-process',
        inProcessServer: server,
      } as MCPServerConfig);

    expect(signatureOf(first)).not.toBe(signatureOf(second));
    // The SAME server keeps its identity across a reload.
    expect(signatureOf(first)).toBe(signatureOf(first));
  });
});

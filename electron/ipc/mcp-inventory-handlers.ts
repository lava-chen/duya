import { ipcMain } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { getLogger, LogComponent } from '../logging/logger';
import { getMCPInventoryService } from '../services/mcp-inventory-service';
import type { MCPEffectiveServerDTO } from '../../src/lib/mcp-inventory-types';

interface MCPInventoryToolsRequest {
  serverId: string;
}

interface MCPInventoryToolDTO {
  name: string;
  description?: string;
}

export function registerMCPInventoryHandlers(): void {
  const logger = getLogger();
  const service = getMCPInventoryService();

  ipcMain.handle('mcp:inventory:snapshot', async () => {
    try {
      const snapshot = await service.buildSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        LogComponent.Main,
        `mcp:inventory:snapshot failed: ${message}`,
      );
      return { success: false, error: message };
    }
  });

  ipcMain.handle('mcp:inventory:tools', async (_event, payload: MCPInventoryToolsRequest) => {
    const { serverId } = payload;
    let client: Client | null = null;
    let transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;

    try {
      const snapshot = await service.buildSnapshot();
      const server = snapshot.effectiveServers.find((s: MCPEffectiveServerDTO) => s.id === serverId);
      if (!server) {
        return { success: false, error: 'MCP server not found' };
      }

      if (server.url) {
        transport = new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: server.headers ? { headers: server.headers } : undefined,
        });
      } else {
        transport = new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: server.env,
        });
      }

      client = new Client(
        { name: 'duya-mcp-browser', version: '0.1.0' },
        { capabilities: {} },
      );

      await client.connect(transport);
      const toolsResponse = await client.listTools();
      const data: MCPInventoryToolDTO[] = toolsResponse.tools.map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      }));

      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(LogComponent.Main, `mcp:inventory:tools failed for ${serverId}: ${message}`);
      return { success: false, error: message };
    } finally {
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
    }
  });
}

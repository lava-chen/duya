/** Main-process bridge for official Remote MCP tools. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  ConnectorInputSchema,
  ConnectorInvokeResult,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';
import { getProviderConfig } from '../providers/registry.js';
import { createStoredRemoteMcpOAuthProvider } from '../oauth/remote-mcp-flow.js';
import type { TokenVault } from '../token-vault.js';

interface RemoteSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Map<string, { description: string; inputSchema: ConnectorInputSchema }>;
}

function toolAlias(provider: ProviderId, toolName: string): string {
  return `remote_${provider}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * A Remote MCP is executed entirely in Electron main. The Agent receives only
 * a descriptor and redacted result through appConnection:invoke; the bearer
 * token is attached to the HTTP request in this class and never crosses IPC.
 */
export class RemoteMcpConnector {
  private readonly sessions = new Map<string, RemoteSession>();

  constructor(private readonly vault: TokenVault) {}

  async listDescriptors(
    connectionId: string,
    provider: ProviderId,
    token: { accessToken: string; tokenType: string },
  ): Promise<ConnectorToolDescriptor[]> {
    const session = await this.ensureSession(connectionId, provider, token);
    return [...session.tools.entries()].map(([name, tool]) => ({
      name: toolAlias(provider, name),
      description: tool.description || `${provider} Remote MCP tool: ${name}`,
      inputSchema: tool.inputSchema,
      inputSchemaSummary: `Official ${provider} Remote MCP: ${name}`,
      // Remote servers control their own tools. Until their action metadata is
      // normalized by provider adapters, fail closed and request confirmation.
      riskTier: 'modify',
      provider,
      connectionId,
      action: `remote:${name}`,
    }));
  }

  async invoke(
    connectionId: string,
    provider: ProviderId,
    action: string,
    args: unknown,
    token: { accessToken: string; tokenType: string },
  ): Promise<ConnectorInvokeResult> {
    if (!action.startsWith('remote:')) {
      return { success: false, error: { code: 'unknown_action', message: 'Invalid Remote MCP action', retriable: false } };
    }
    const session = await this.ensureSession(connectionId, provider, token);
    const toolName = action.slice('remote:'.length);
    if (!session.tools.has(toolName)) {
      return { success: false, error: { code: 'unknown_action', message: `Remote MCP tool is unavailable: ${toolName}`, retriable: false } };
    }
    const result = await session.client.callTool(
      { name: toolName, arguments: isRecord(args) ? args : {} },
      CallToolResultSchema,
    );
    return {
      success: !result.isError,
      data: {
        content: result.content,
        isError: result.isError === true,
      },
      ...(result.isError
        ? { error: { code: 'provider_error', message: `Remote MCP tool failed: ${toolName}`, retriable: false } }
        : {}),
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    const session = this.sessions.get(connectionId);
    this.sessions.delete(connectionId);
    if (!session) return;
    await session.client.close().catch(() => undefined);
    await session.transport.close().catch(() => undefined);
  }

  private async ensureSession(
    connectionId: string,
    provider: ProviderId,
    token: { accessToken: string; tokenType: string },
  ): Promise<RemoteSession> {
    const current = this.sessions.get(connectionId);
    if (current) return current;
    const config = getProviderConfig(provider);
    if (!config.remoteMcpUrl) throw new Error(`${provider} is not a Remote MCP provider`);

    const transport = new StreamableHTTPClientTransport(new URL(config.remoteMcpUrl), {
      authProvider: createStoredRemoteMcpOAuthProvider(this.vault, connectionId),
    });
    const client = new Client({ name: 'duya-desktop', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = new Map(
        listed.tools.map((tool) => [
          tool.name,
          {
            description: tool.description ?? '',
            inputSchema: normalizeInputSchema(tool.inputSchema),
          },
        ]),
      );
      const session = { client, transport, tools };
      this.sessions.set(connectionId, session);
      return session;
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeInputSchema(value: unknown): ConnectorInputSchema {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) {
    return { type: 'object', properties: {} };
  }
  return {
    type: 'object',
    properties: value.properties,
    ...(Array.isArray(value.required) && value.required.every((name) => typeof name === 'string')
      ? { required: value.required as string[] }
      : {}),
  };
}

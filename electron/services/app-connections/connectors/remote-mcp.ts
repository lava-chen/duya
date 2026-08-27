/** Main-process bridge for official Remote MCP tools. */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  deleteCatalogCache,
  isFresh,
  readCatalogCache,
  writeCatalogCache,
  type CachedSnapshot,
} from '../catalog-cache.js';
import type {
  ConnectorInputSchema,
  ConnectorInvokeResult,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';
import { getProviderConfig } from '../providers/registry.js';
import { createStoredRemoteMcpOAuthProvider } from '../oauth/remote-mcp-flow.js';
import type { TokenVault } from '../token-vault.js';
import {
  evaluateRemoteToolRiskTier,
  parseRemoteToolAnnotations,
  type RemoteToolAnnotations,
} from '../risk-policy.js';

interface RemoteSession {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Map<
    string,
    {
      description: string;
      inputSchema: ConnectorInputSchema;
      annotations?: RemoteToolAnnotations;
    }
  >;
}

/**
 * Plan 450 Phase E: hydrated tool shape used by both the live
 * `listTools()` path and the catalog cache fast-path. Identical to
 * `RemoteSession['tools']`'s value type but lifted to a named alias so
 * the cache hydration helper can return a typed map without circular
 * aliasing.
 */
type HydratedTool = {
  description: string;
  inputSchema: ConnectorInputSchema;
  annotations?: RemoteToolAnnotations;
};

function hydrateTools(raw: import('../catalog-cache.js').CachedSnapshot['tools']): Map<string, HydratedTool> {
  return new Map(
    raw.map((tool) => [
      tool.name,
      {
        description: tool.description ?? '',
        inputSchema: normalizeInputSchema(tool.inputSchema),
        annotations: parseRemoteToolAnnotations(tool.annotations),
      },
    ]),
  );
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
    return [...session.tools.entries()].map(([name, tool]) => {
      // Plan 449: trust server-published hints for read-only tools instead of
      // prompting on every call. Anything uninformative stays `modify`.
      const { tier, source } = evaluateRemoteToolRiskTier(tool.annotations);
      return {
        name: toolAlias(provider, name),
        description: tool.description || `${provider} Remote MCP tool: ${name}`,
        inputSchema: tool.inputSchema,
        inputSchemaSummary: `Official ${provider} Remote MCP: ${name}`,
        riskTier: tier,
        tierSource: source,
        ...(tool.annotations?.title ? { title: tool.annotations.title } : {}),
        provider,
        connectionId,
        action: `remote:${name}`,
      };
    });
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
    let result;
    try {
      result = await session.client.callTool(
        { name: toolName, arguments: isRecord(args) ? args : {} },
        CallToolResultSchema,
      );
    } catch (error) {
      // Plan 450: mid-call auth failure (token revoked server-side after the
      // session cached the bearer). Surface a structured `connector_auth_required`
      // error so the agent-side executor can emit an elicitation event and the
      // renderer can prompt for re-authorization. The MCP SDK's authProvider
      // would otherwise loop on refresh attempts the user can't see.
      if (error instanceof UnauthorizedError) {
        return {
          success: false,
          error: {
            code: 'connector_auth_required',
            message: `Remote MCP session for ${provider} requires re-authorization`,
            retriable: false,
          },
        };
      }
      throw error;
    }
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
    // Plan 450 Phase E: also drop the catalog snapshot so the next
    // re-authorization starts from a fresh tools/list rather than
    // reusing stale state.
    deleteCatalogCache(connectionId);
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
      // Plan 450 Phase E: try the persistent catalog cache first so

      // cold starts don't pay the network round-trip on every session.

      // Stale entries re-fetch foreground; fresh entries skip

      // `listTools()` entirely. The transport/auth is still set up.

      const cached = readCatalogCache(connectionId);

      let tools: Map<string, HydratedTool>;

      if (cached && cached.provider === provider && isFresh(cached) && cached.tools.length > 0) {

        tools = hydrateTools(cached.tools);

      } else {

        const listed = await client.listTools();

        tools = new Map(

          listed.tools.map((tool) => [

            tool.name,

            {

              description: tool.description ?? '',

              inputSchema: normalizeInputSchema(tool.inputSchema),

              annotations: parseRemoteToolAnnotations(tool.annotations),

            },

          ]),

        );

        writeCatalogCache(

          connectionId,

          provider,

          listed.tools.map((tool) => ({

            name: tool.name,

            ...(tool.description !== undefined ? { description: tool.description } : {}),

            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),

            ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),

          })),

        );

      }

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

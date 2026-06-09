/**
 * ListMcpResourcesTool - List resources exposed by connected MCP servers.
 *
 * MCP servers can expose a read-only "resources" data plane (files, DB
 * rows, API snapshots) in addition to the callable tools. This tool
 * surfaces those resources so the model can discover what's available
 * before calling `read_mcp_resource`.
 *
 * Wiring:
 *   - The `mcpManagerProvider` is set at registry construction time by
 *     whoever owns the MCP lifecycle (electron main, CLI bootstrap, etc.).
 *     This avoids the package-level singleton the previous version used
 *     and lets the tool see exactly the same connections the rest of
 *     the agent sees.
 *   - `setMcpResources()` is kept as a fallback for tests and for
 *     callers that prefer to push a snapshot rather than hand the tool
 *     a manager reference.
 *
 * A snapshot is taken on every call — there is no in-memory cache
 * because resource lists can change (servers come and go, the user
 * adds new ones from settings, etc.) and the call is cheap.
 */

import type { Tool, ToolResult, MCPResource } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { LIST_MCP_RESOURCES_TOOL_NAME } from './constants.js';
import { DESCRIPTION, getPrompt } from './prompt.js';

// Minimal shape we need from the MCP layer. We don't import the concrete
// `MCPManager` class to keep this file free of a hard dependency on the
// `mcp/` subsystem — any object that exposes `getAllClients()` returning
// items with `isConnected()` / `getName()` / `listResources()` works.
interface MCPManagerLike {
  getAllClients(): Array<{
    getName(): string;
    isConnected(): boolean;
    listResources?(): Promise<Array<{ uri: string; name?: string; description?: string; mimeType?: string }>>;
  }>;
}

let mcpResourcesSnapshot: MCPResource[] = [];
let mcpManagerProvider: (() => MCPManagerLike | undefined) | null = null;

export function setMcpResources(resources: MCPResource[]): void {
  mcpResourcesSnapshot = resources;
}

export function getMcpResources(): MCPResource[] {
  return mcpResourcesSnapshot;
}

/**
 * Wire the tool to a live MCPManager accessor. Called once at registry
 * construction time. The accessor is invoked on every tool call so
 * connections that come and go (e.g. settings reload) are reflected
 * without re-wiring.
 */
export function setMcpManagerProvider(provider: () => MCPManagerLike | undefined): void {
  mcpManagerProvider = provider;
}

interface ResolvedResource extends MCPResource {
  server?: string;
}

async function resolveFromManager(manager: MCPManagerLike): Promise<ResolvedResource[]> {
  const out: ResolvedResource[] = [];
  for (const client of manager.getAllClients()) {
    if (!client.isConnected()) continue;
    if (typeof client.listResources !== 'function') continue;
    try {
      const resources = await client.listResources();
      for (const r of resources) {
        // MCPResource.name is required; fall back to the URI's last path
        // segment if the server didn't provide one (some don't).
        const name = r.name ?? r.uri.split('/').filter(Boolean).pop() ?? r.uri;
        out.push({
          uri: r.uri,
          name,
          ...(r.description !== undefined && { description: r.description }),
          ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
          server: client.getName(),
        });
      }
    } catch {
      // One server's failure shouldn't sink the whole list. The underlying
      // client.listResources already swallows "Method not found" but we
      // belt-and-suspenders here too.
    }
  }
  return out;
}

export class ListMcpResourcesTool implements Tool, ToolExecutor {
  readonly name = LIST_MCP_RESOURCES_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'Optional MCP server name to filter resources by. Omit to list resources from all connected servers.',
      },
    },
    required: [],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown> = {}): Promise<ToolResult> {
    const serverFilter = typeof input.server === 'string' ? input.server.trim() : undefined;

    // Prefer live data from the MCPManager; fall back to a pushed snapshot
    // when no provider is wired (e.g. unit tests, ad-hoc CLI use).
    let resources: ResolvedResource[];
    if (mcpManagerProvider) {
      const manager = mcpManagerProvider();
      if (manager) {
        resources = await resolveFromManager(manager);
      } else {
        resources = mcpResourcesSnapshot.map((r) => ({ ...r }));
      }
    } else {
      resources = mcpResourcesSnapshot.map((r) => ({ ...r }));
    }

    if (serverFilter) {
      resources = resources.filter((r) => r.server === serverFilter);
      if (resources.length === 0) {
        // Surface "no resources" distinctly from "server not found" so the
        // model can tell the difference between a typo and a server that
        // simply has no resources.
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: JSON.stringify({
            resources: [],
            count: 0,
            server: serverFilter,
            message: `Server "${serverFilter}" has no resources (or is not connected).`,
          }),
        };
      }
    }

    if (resources.length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          resources: [],
          count: 0,
          message: 'No MCP resources available. Connect to an MCP server that exposes resources (some servers expose only tools, not resources).',
        }),
      };
    }

    const lines = resources.map((r) => {
      const desc = r.description ? ` - ${r.description}` : '';
      const server = r.server ? ` [${r.server}]` : '';
      return `${r.uri}: ${r.name ?? '(unnamed)'}${server}${desc}`;
    });

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        resources,
        count: resources.length,
      }) + '\n' + lines.join('\n'),
    };
  }

  getPrompt(): string {
    return getPrompt();
  }
}

export const listMcpResourcesTool = new ListMcpResourcesTool();

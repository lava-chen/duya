import type { ToolRegistry } from '../registry.js';
import type { ToolCatalogNamespace } from './ToolSchemaTool.js';

/**
 * Plan 480 P2.1/P2.3 — catalog provider backed by a live ToolRegistry.
 *
 * Builds the read-only namespace catalog that `tool_schema` serves:
 *   - MCP-owned tools: one namespace per `mcpInfo.serverName` (source 'mcp').
 *   - Non-MCP `discoverable` tools (plan 241 on-demand tools like
 *     image_generate): a single reserved `builtin` namespace (source
 *     'builtin'), added by plan 480 P2.3 so the model can discover and
 *     invoke them through the meta tools without the legacy next-turn
 *     injection path.
 *
 * `always` tools are excluded (they are already in the request's tools
 * array — discovering them through tool_schema would be redundant);
 * `internal` tools are excluded entirely.
 *
 * Deterministic ordering: namespaces are sorted by name and tools within a
 * namespace by name, so the discovery surface is byte-stable across turns
 * while the toolset is unchanged.
 *
 * The schema handed out is the registered definition's input_schema — the
 * same schema the toolset serializes, so discovery never promises more than
 * the executor can accept.
 */

/** Reserved namespace for non-MCP discoverable built-in tools. */
export const BUILTIN_TOOLS_NAMESPACE = 'builtin';

export function createToolSchemaProviderFromRegistry(
  registry: ToolRegistry,
): { getCatalog(): ToolCatalogNamespace[] } {
  return {
    getCatalog(): ToolCatalogNamespace[] {
      const namespaces = new Map<string, ToolCatalogNamespace>();
      const builtinNs: ToolCatalogNamespace = {
        namespace: BUILTIN_TOOLS_NAMESPACE,
        source: 'builtin',
        tools: [],
      };

      for (const tool of registry.getAllTools()) {
        if (registry.getOwner(tool.name) === 'mcp') {
          const info = tool.mcpInfo;
          if (!info) continue;

          let ns = namespaces.get(info.serverName);
          if (!ns) {
            ns = { namespace: info.serverName, source: 'mcp', tools: [] };
            namespaces.set(info.serverName, ns);
          }
          if (!ns.tools.some((entry) => entry.name === info.toolName)) {
            ns.tools.push({
              name: info.toolName,
              description: tool.description,
              inputSchema: tool.input_schema,
            });
          }
          continue;
        }

        // Non-MCP discoverable built-ins join the reserved builtin namespace.
        if (registry.getExposeMode(tool.name) !== 'discoverable') continue;
        if (!builtinNs.tools.some((entry) => entry.name === tool.name)) {
          builtinNs.tools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
          });
        }
      }

      if (builtinNs.tools.length > 0) {
        namespaces.set(BUILTIN_TOOLS_NAMESPACE, builtinNs);
      }

      return [...namespaces.values()]
        .sort((a, b) => (a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0))
        .map((ns) => ({
          ...ns,
          tools: [...ns.tools].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
        }));
    },
  };
}

import type { ExposeMode, ToolRegistry } from '../registry.js';
import type { ToolCatalogNamespace } from './ToolSchemaTool.js';

/**
 * Plan 480 P2.1/P2.3 — catalog provider backed by a live ToolRegistry.
 *
 * Builds the read-only namespace catalog that `tool_schema` serves:
 *   - MCP-owned tools: one namespace per `mcpInfo.serverName` (source 'mcp').
 *   - Non-MCP `hint` / `discoverable` tools (on-demand tools like
 *     image_generate, and hint-tier dynamic tools): a single reserved
 *     `builtin` namespace (source 'builtin'), added by plan 480 P2.3 so
 *     the model can discover and invoke them through the meta tools.
 *
 * Under the four-tier exposure model the catalog carries exactly the tools
 * whose full schema is NOT on the request's tools array: `hint` (stub entry
 * with an empty schema) and `discoverable` (absent until found).
 * `always` tools are excluded (their full schema already rides every
 * request); `hidden` tools are excluded entirely.
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

/** Expose modes whose full schema is served through the tool_schema catalog. */
function isCatalogVisible(mode: ExposeMode): boolean {
  return mode === 'hint' || mode === 'discoverable';
}

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
        const mode = registry.getExposeMode(tool.name);
        if (registry.getOwner(tool.name) === 'mcp') {
          if (!isCatalogVisible(mode)) continue;
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

        // Non-MCP hint/discoverable built-ins join the reserved builtin
        // namespace.
        if (!isCatalogVisible(mode)) continue;
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

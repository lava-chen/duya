import type { Tool } from '../types.js';

/**
 * packages/agent/src/mcp/capability-catalog.ts
 *
 * Plan 480 P1 — deterministic, budgeted MCP tool catalog renderer.
 *
 * The catalog is the "schema-free directory" shown to the model: it lists
 * connected MCP servers and their tool NAMES only — never input schemas.
 * Full schemas are fetched on demand through `tool_schema` (Plan 480 P2),
 * so this directory must be byte-for-byte stable across turns while the
 * toolset is unchanged. Stability is a hard requirement: it feeds the
 * provider prompt-cache prefix (Plan 480 §8.8).
 *
 * Two properties guarantee determinism:
 *  1. Servers are sorted by (name, source) — byte order, locale-independent.
 *  2. Tool names WITHIN a server are sorted by name, so connection /
 *     registration order (a Map insertion order) can never leak into the
 *     rendered string.
 *
 * The renderer is a pure function over `readonly Tool[]`; callers decide
 * which tools to feed it (the MCP owner filter is applied by callers at
 * `DuyaAgent.ts` / `agent-shell.ts`).
 */

const MAX_SERVERS = 12;
const MAX_TOOL_NAMES_PER_SERVER = 4;
const MAX_LABEL_LENGTH = 80;
/** Total character budget for the rendered server list (2–4k range). */
const DEFAULT_MAX_TOTAL_CHARS = 4096;

type MCPSource = NonNullable<Tool['mcpInfo']>['source'];

export interface ToolCatalogOptions {
  /** Hard cap on listed servers (default 12). */
  maxServers?: number;
  /** Hard cap on tool names shown per server (default 4). */
  maxToolsPerServer?: number;
  /** Total character budget for the server list body (default 4096). */
  maxTotalChars?: number;
  /**
   * Warming flag (Plan 480 §8.1 / grok `mcpInfoComplete`): when the MCP
   * connection set is still converging, annotate the directory so the model
   * does not treat it as final.
   */
  incomplete?: boolean;
  /**
   * Which entry point the directory instructs the model to use for listed
   * tools. `'tool_search'` (default) keeps today's guidance; `'tool_invoke'`
   * is used when the MCP exposure policy is `catalog` (plan 480 §8.4) — the
   * model must read schemas via `tool_schema` and invoke via `tool_invoke`
   * because those tools are NOT in the request's tools array.
   */
  entryPoint?: 'tool_search' | 'tool_invoke';
}

interface CatalogServer {
  name: string;
  source: MCPSource;
  toolNames: string[];
}

function displaySource(source: MCPSource): string {
  switch (source) {
    case 'settings':
      return 'user config.toml';
    case 'plugin':
      return 'plugin';
    case 'bundled':
      return 'bundled';
    default:
      return 'external';
  }
}

function safeLabel(value: string): string {
  return value
    .replace(/[\r\n\t]/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

/**
 * Group MCP tools into per-server entries. The Map key is
 * `${source}:${serverName}` so two same-named servers from different
 * sources (user config vs plugin) stay separate.
 */
function groupByServer(tools: readonly Tool[]): Map<string, CatalogServer> {
  const servers = new Map<string, CatalogServer>();

  for (const tool of tools) {
    const info = tool.mcpInfo;
    if (!info) continue;

    const key = `${info.source}:${info.serverName}`;
    const server = servers.get(key) ?? {
      name: safeLabel(info.serverName),
      source: info.source,
      toolNames: [],
    };
    const toolName = safeLabel(info.toolName);
    if (toolName && !server.toolNames.includes(toolName)) {
      server.toolNames.push(toolName);
    }
    servers.set(key, server);
  }
  return servers;
}

/**
 * Deterministic render of the server list body. Each server renders at most
 * `maxToolsPerServer` tool names (sorted), with a "+N more" suffix. Servers
 * are consumed in sorted order until `maxTotalChars` is exhausted; remaining
 * servers are reported once in an omission line so the model knows the
 * directory is bounded.
 */
function renderServerLines(
  entries: CatalogServer[],
  maxToolsPerServer: number,
  maxTotalChars: number,
): { lines: string[]; omitted: number; truncatedNames: number } {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  let truncatedNames = 0;

  for (const server of entries) {
    const toolNames = [...server.toolNames].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const shown = toolNames.slice(0, maxToolsPerServer).join(', ');
    const remaining =
      toolNames.length - Math.min(toolNames.length, maxToolsPerServer);
    const suffix = remaining > 0 ? `, +${remaining} more` : '';
    const line = `- \`${server.name}\` (${displaySource(server.source)}, ${server.toolNames.length} tools): ${shown}${suffix}`;

    if (lines.length > 0 && used + line.length + 1 > maxTotalChars) {
      // Budget exhausted — the rest of the (already sorted) servers are
      // omitted. Truncation happens only between servers, never mid-line,
      // so every emitted line stays valid.
      omitted = entries.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    if (remaining > 0) truncatedNames += 1;
  }

  return { lines, omitted, truncatedNames };
}

/**
 * Build a compact, schema-free directory of MCP capabilities.
 *
 * @param tools - MCP tool definitions (callers pre-filter to owner 'mcp').
 * @param options - Rendering options (caps, warming annotation).
 * @returns A markdown directory string, or '' when no MCP tools are present.
 */
export function buildMCPCapabilityCatalog(
  tools: readonly Tool[],
  options?: ToolCatalogOptions,
): string {
  const maxServers = options?.maxServers ?? MAX_SERVERS;
  const maxToolsPerServer = options?.maxToolsPerServer ?? MAX_TOOL_NAMES_PER_SERVER;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  const servers = groupByServer(tools);
  if (servers.size === 0) return '';

  const entries = [...servers.values()]
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.source.localeCompare(b.source),
    )
    .slice(0, maxServers);

  const { lines, omitted, truncatedNames } = renderServerLines(
    entries,
    maxToolsPerServer,
    maxTotalChars,
  );

  const extra: string[] = [];
  if (options?.incomplete === true) {
    extra.push(
      '- MCP server discovery is still warming: the list above may be incomplete; additional servers may become available shortly.',
    );
  }
  if (truncatedNames > 0) {
    extra.push(
      '- Use `tool_schema({namespace})` to list every tool of a server, or `tool_schema({namespace, tool})` for one tool’s full schema.',
    );
  }
  if (omitted > 0) {
    extra.push(
      `- ${omitted} additional MCP server(s) omitted from this compact directory.`,
    );
  }

  const closingLine =
    options?.entryPoint === 'tool_invoke'
      ? 'When an MCP capability is needed, call `tool_schema` with the server name to read a tool’s schema, then invoke it with `tool_invoke`. The MCP tools are not in your default tool list — never fabricate their arguments. Do not claim that a server is unavailable merely because its individual tools are not in the default tool list.'
      : 'When an MCP capability is needed, call `tool_search` with the server name or the operation you need. Do not claim that a server is unavailable merely because its individual tools are not in the default tool list.';

  return [
    '## MCP Capability Directory',
    '',
    'These MCP servers are connected for this task. Their full schemas are intentionally loaded on demand.',
    ...lines,
    ...extra,
    '',
    closingLine,
  ].join('\n');
}

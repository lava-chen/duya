// Shared identity parsing for tool rows that dispatch external tools.
//
// Two transports carry the same notion of "which app / server did this":
// 1. `tool_invoke` (Plan 480) — the input's `tool_id` is the stable catalog
//    ID produced by `createToolId` in packages/agent catalog-identity:
//    `kind:encodedSourceId:encodedToolName` (encodeURIComponent escapes
//    the ':' separators, so the format is exactly three segments).
// 2. Direct eager MCP calls — provider-visible names `mcp_<server>_<tool>`;
//    the sanitizer collapses the internal `__` separators, so the split is
//    a heuristic (first token = server; see describeMcpProviderName).
//
// This parser intentionally mirrors `parseInvokeToolId` in
// packages/ai/src/utils/context-estimate.ts instead of importing it: the
// renderer resolves @duya/ai from its built dist, and a copy here keeps the
// chat-tool chrome decoupled from that build step.

export type InvokeSourceKind = 'builtin' | 'mcp' | 'plugin' | 'connector';

export interface ParsedInvokeToolId {
  kind: InvokeSourceKind;
  /** Decoded source identity — provider id for connectors (`slack`),
   *  server name for MCP, `pluginId:connection` for plugin-owned MCP. */
  source: string;
  /** Decoded per-tool name (may repeat the source as a prefix). */
  toolName: string;
}

export function parseInvokeToolId(raw: string): ParsedInvokeToolId | null {
  const segments = raw.split(':');
  if (segments.length < 3) return null;
  const kind = segments[0];
  if (kind !== 'builtin' && kind !== 'mcp' && kind !== 'plugin' && kind !== 'connector') {
    return null;
  }
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    kind,
    source: decode(segments[1]),
    toolName: decode(segments.slice(2).join(':')),
  };
}

/** `slack_post_message` → `Post message`; `get_environment` → `Get environment`.
 *  ZCode parity: mechanical snake/kebab → Title Case, no dictionary. */
export function humanizeToolLabel(name: string): string {
  const words = name.trim().replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ');
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Drop a repeated source prefix so the summary reads "Slack · Add source"
 *  instead of "Slack · Slack add source" (many MCP/connector tools repeat
 *  their server name as the tool prefix). Case-insensitive, mechanical;
 *  the remainder is re-capitalized ("Github create issue" → "Create issue"). */
export function dedupeSourcePrefix(toolLabel: string, sourceLabel: string): string {
  if (!sourceLabel) return toolLabel;
  const prefix = `${sourceLabel} `;
  if (!toolLabel.toLowerCase().startsWith(prefix.toLowerCase())) return toolLabel;
  const rest = toolLabel.slice(prefix.length);
  if (!rest) return toolLabel;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Display label for a parsed source. Plugin-owned MCP ids are namespaced
 *  `pluginId:connection` — the connection segment is the user-facing name;
 *  provider ids and server names are Title Cased for the chrome. */
export function formatInvokeSourceLabel(kind: InvokeSourceKind, source: string): string {
  if (kind === 'plugin') {
    const last = source.split(':').filter(Boolean).at(-1);
    return last ? humanizeToolLabel(last) : 'plugin';
  }
  return humanizeToolLabel(source);
}

export interface McpProviderNameParts {
  /** Server segment — everything before the LAST `_` of the provider name. */
  server: string;
  /** Per-tool segment (raw, may repeat the server as a prefix). */
  toolName: string;
}

/**
 * Split a direct eager MCP provider name (`mcp_<server>_<tool>`) into its
 * server and tool segments. The sanitizer collapses the internal `__`
 * separators to `_`, so the split is a heuristic: the FIRST token is the
 * server (tool names are typically multi-word — `create_issue` — while
 * server names are single-token). Returns null when the name is not
 * MCP-shaped.
 */
export function describeMcpProviderName(name: string): McpProviderNameParts | null {
  if (!name.toLowerCase().startsWith('mcp_')) return null;
  const rest = name.slice('mcp_'.length);
  if (!rest) return null;
  const firstSep = rest.indexOf('_');
  return {
    server: firstSep !== -1 ? rest.slice(0, firstSep) : rest,
    toolName: firstSep !== -1 ? rest.slice(firstSep + 1) : '',
  };
}

export interface InvokeIdentity {
  kind: InvokeSourceKind;
  /** Raw source id (used to pick the connector brand icon). */
  sourceId: string;
  /** Display label — Title Cased provider/server name ('' for builtin). */
  sourceLabel: string;
  /** Humanized tool label with a repeated source prefix removed. */
  toolLabel: string;
}

/**
 * Resolve the display identity of a tool_invoke action from its input.
 * Accepts the current `{ tool_id, arguments }` shape and the legacy
 * Plan-480 draft `{ namespace, tool }` shape still present in older
 * transcripts. Returns null when neither shape is recognizable — callers
 * fall back to the generic invoke row.
 */
export function describeInvokeTool(input: unknown): InvokeIdentity | null {
  const inp = (input || {}) as Record<string, unknown>;
  const toolId = typeof inp.tool_id === 'string' ? inp.tool_id.trim() : '';
  if (toolId) {
    const parsed = parseInvokeToolId(toolId);
    if (parsed) {
      const sourceLabel =
        parsed.kind === 'builtin' ? '' : formatInvokeSourceLabel(parsed.kind, parsed.source);
      return {
        kind: parsed.kind,
        sourceId: parsed.source,
        sourceLabel,
        toolLabel: dedupeSourcePrefix(humanizeToolLabel(parsed.toolName), sourceLabel),
      };
    }
    // Unparseable ID — show it verbatim rather than dropping the row's
    // meaning (the model did address a real catalog entry).
    return { kind: 'mcp', sourceId: '', sourceLabel: '', toolLabel: toolId };
  }
  const namespace = typeof inp.namespace === 'string' ? inp.namespace.trim() : '';
  const tool = typeof inp.tool === 'string' ? inp.tool.trim() : '';
  if (namespace && namespace !== 'builtin') {
    const sourceLabel = formatInvokeSourceLabel('mcp', namespace);
    return {
      kind: 'mcp',
      sourceId: namespace,
      sourceLabel,
      toolLabel: dedupeSourcePrefix(humanizeToolLabel(tool), sourceLabel),
    };
  }
  if (tool) {
    return { kind: 'builtin', sourceId: '', sourceLabel: '', toolLabel: humanizeToolLabel(tool) };
  }
  return null;
}

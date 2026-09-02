import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';

/**
 * Plan 480 P2.1 — `tool_schema` discovery meta tool.
 *
 * Reads schemas of tools that are NOT in the request's `tools` array
 * (catalog / deferred exposure). The meta tool itself is byte-constant: the
 * model first discovers a schema here, then invokes through `tool_invoke`.
 *
 * Modes (aligned with grok's `GetMcpTools`):
 *   1. { "namespace": "<id>" }                → full schema + description of
 *                                              every tool in that namespace
 *   2. { "namespace": "<id>", "tool": "<n>" } → one tool, full schema
 *   3. { "pattern": "<regex>" }               → search namespace + tool names
 *   4. (no arguments)                          → catalog overview
 *
 * Truncation contract: overview (mode 4) and pattern (mode 3) results
 * shorten long descriptions, marked by TRUNCATED_DESCRIPTION_SUFFIX, so the
 * model knows a full read via mode 1/2 is available. Namespace and
 * single-tool lookups always return complete descriptions and schemas.
 *
 * The executor is a dumb data reader: all access goes through the injected
 * catalog provider (no registry coupling), so this module is unit-testable
 * with a fake provider and only gains the live registry in P3 wiring.
 */

export const TOOL_SCHEMA_NAME = 'tool_schema';
export const TOOL_SCHEMA_RESULT_MARKER = '<!-- duya-tool-schema-result -->';
export const TRUNCATED_DESCRIPTION_SUFFIX = '... [truncated]';
export const TRUNCATED_SCHEMA_SUFFIX = '... [schema truncated]';

/** Long descriptions in overview/pattern results are cut to this length. */
const MAX_OVERVIEW_DESCRIPTION_CHARS = 200;
/** Full schema JSON is capped per tool so one oversized server cannot blow
 *  a discovery result. Bodies over this are truncated and marked. */
const MAX_SCHEMA_JSON_CHARS = 24_000;
/** Overview/pattern results list at most this many tools per namespace. */
const MAX_TOOLS_PER_OVERVIEW_NAMESPACE = 50;

export interface ToolSchemaEntry {
  name: string;
  description?: string;
  /** Raw JSON Schema. May be large — the tool truncates on textification. */
  inputSchema?: unknown;
}

export interface ToolCatalogNamespace {
  namespace: string;
  source?: string;
  tools: ToolSchemaEntry[];
}

/** Injected by the agent (P3 wiring) — read-only snapshot of the catalog. */
export interface ToolSchemaCatalogProvider {
  getCatalog(): ToolCatalogNamespace[];
}

const DESCRIPTION = `Discover the schema of a tool that is not in the current tool list.

Tools reachable this way live under namespaces (typically one MCP server per namespace). Read a tool's schema with this tool BEFORE invoking it with \`tool_invoke\`.

Modes:
1. \`{"namespace":"<id>"}\`: full input schema and description for every tool in that namespace. Prefer when you know the namespace.
2. \`{"namespace":"<id>","tool":"<name>"}\`: full schema and description for one tool.
3. \`{"pattern":"<regex>"}\`: search namespace and tool names (RE2-like syntax: no backreferences, lookahead, or lookbehind). Use when unsure which namespace has the tool.
4. No arguments: catalog of all namespaces with tool names and short descriptions. Use only when you have no idea where to look.

MANDATORY: always call this tool to read a tool's schema before invoking it with \`tool_invoke\`.`;

function safeLine(value: string, max: number): string {
  return value.replace(/[\r\n]/g, ' ').trim().slice(0, max);
}

function truncateDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.replace(/[\r\n]/g, ' ').trim();
  if (text.length <= MAX_OVERVIEW_DESCRIPTION_CHARS) return text;
  return `${text.slice(0, MAX_OVERVIEW_DESCRIPTION_CHARS)}${TRUNCATED_DESCRIPTION_SUFFIX}`;
}

function renderSchema(inputSchema: unknown): string | undefined {
  if (inputSchema === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(inputSchema, null, 2);
  } catch {
    json = String(inputSchema);
  }
  if (json.length <= MAX_SCHEMA_JSON_CHARS) return json;
  return `${json.slice(0, MAX_SCHEMA_JSON_CHARS)}${TRUNCATED_SCHEMA_SUFFIX}`;
}

function renderNamespaceList(catalog: ToolCatalogNamespace[]): string {
  const lines: string[] = [];
  for (const ns of catalog) {
    const toolNames = ns.tools.map((t) => t.name);
    const shown = toolNames.slice(0, MAX_TOOLS_PER_OVERVIEW_NAMESPACE).join(', ');
    const remaining =
      toolNames.length - Math.min(toolNames.length, MAX_TOOLS_PER_OVERVIEW_NAMESPACE);
    const suffix = remaining > 0 ? `, +${remaining} more` : '';
    const sourceAttr = ns.source ? ` (${safeLine(ns.source, 60)})` : '';
    lines.push(`- \`${safeLine(ns.namespace, 120)}\`${sourceAttr}: ${shown}${suffix}`);
  }
  return lines.length > 0 ? lines.join('\n') : '_No namespaces connected._';
}

/** Full per-tool block used by modes 1 and 2. */
function renderFullTool(
  namespace: string,
  entry: ToolSchemaEntry,
): string {
  const parts = [`## Tool: \`${entry.name}\``, ''];
  if (entry.description) {
    parts.push(entry.description.trim(), '');
  }
  const schema = renderSchema(entry.inputSchema);
  if (schema !== undefined) {
    parts.push('**Input schema:**', '', '```json', schema, '```');
  } else {
    parts.push('_No input schema declared._');
  }
  parts.push('', `Namespace: \`${namespace}\`.`);
  return parts.join('\n');
}

/** Short per-tool line used by modes 3 and 4 (descriptions truncated). */
function renderShortTool(entry: ToolSchemaEntry): string {
  const description = truncateDescription(entry.description);
  const suffix = description ? ` — ${description}` : '';
  return `- \`${entry.name}\`${suffix}`;
}

export class ToolSchemaTool implements Tool, ToolExecutor {
  readonly name = TOOL_SCHEMA_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Namespace (e.g. an MCP server name) to list tools for',
      },
      tool: {
        type: 'string',
        description: 'Tool name within the namespace (requires namespace)',
      },
      pattern: {
        type: 'string',
        description:
          'Regex over namespace and tool names (RE2-like: no backreferences/lookahead/lookbehind)',
      },
    },
  };

  private provider?: ToolSchemaCatalogProvider;

  setProvider(provider: ToolSchemaCatalogProvider): void {
    this.provider = provider;
  }

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    } as Tool;
  }

  private errorResult(title: string, body: string): ToolResult {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: `${TOOL_SCHEMA_RESULT_MARKER}\n\n# ${title}\n\n${body}`,
      error: true,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.provider) {
      return this.errorResult(
        'Tool Schema Error',
        'Tool schema discovery is not configured.',
      );
    }

    const namespace =
      typeof input.namespace === 'string' ? input.namespace : undefined;
    const tool = typeof input.tool === 'string' ? input.tool : undefined;
    const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;

    if (pattern !== undefined && namespace !== undefined) {
      return this.errorResult(
        'Tool Schema Error',
        'Provide either `{namespace[, tool]}` or `{pattern}`, not both.',
      );
    }
    if (tool !== undefined && namespace === undefined) {
      return this.errorResult(
        'Tool Schema Error',
        '`tool` requires `namespace`.',
      );
    }

    const catalog = this.provider.getCatalog() ?? [];

    // Mode 1 / 2: namespace lookup (full schemas).
    if (namespace !== undefined) {
      const ns = catalog.find((entry) => entry.namespace === namespace);
      if (!ns) {
        const available = catalog.map((entry) => `\`${entry.namespace}\``).join(', ');
        return this.errorResult(
          'Unknown namespace',
          `Namespace \`${namespace}\` is not connected.${
            available ? `\n\nAvailable namespaces: ${available}.` : ''
          }`,
        );
      }

      // Mode 2: single tool.
      if (tool !== undefined) {
        const entry = ns.tools.find((t) => t.name === tool);
        if (!entry) {
          const names = ns.tools.map((t) => `\`${t.name}\``).join(', ');
          return this.errorResult(
            'Unknown tool',
            `Tool \`${tool}\` does not exist in namespace \`${namespace}\`.${
              names ? `\n\nAvailable tools: ${names}.` : ''
            }`,
          );
        }
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: [
            TOOL_SCHEMA_RESULT_MARKER,
            '',
            `# Tool Schema: \`${namespace}\` / \`${tool}\``,
            '',
            renderFullTool(namespace, entry),
          ].join('\n'),
        };
      }

      // Mode 1: whole namespace.
      if (ns.tools.length === 0) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: `${TOOL_SCHEMA_RESULT_MARKER}\n\n# Tool Schema: \`${namespace}\`\n\n_No tools in this namespace._`,
        };
      }
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          TOOL_SCHEMA_RESULT_MARKER,
          '',
          `# Tool Schema: \`${namespace}\``,
          '',
          ...ns.tools.map((entry) => renderFullTool(namespace, entry)),
        ].join('\n'),
      };
    }

    // Mode 3: pattern search across namespace + tool names.
    if (pattern !== undefined) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        return this.errorResult(
          'Invalid pattern',
          `\`${pattern}\` is not a valid regular expression. Use RE2-like syntax (no backreferences, lookahead, or lookbehind).`,
        );
      }
      const hits: Array<{ namespace: string; entry: ToolSchemaEntry }> = [];
      for (const ns of catalog) {
        if (regex.test(ns.namespace)) {
          // Namespace name matched — surface every tool of it (short form).
          for (const entry of ns.tools) {
            hits.push({ namespace: ns.namespace, entry });
          }
        } else {
          for (const entry of ns.tools) {
            if (regex.test(entry.name)) {
              hits.push({ namespace: ns.namespace, entry });
            }
          }
        }
      }
      if (hits.length === 0) {
        return {
          id: crypto.randomUUID(),
          name: this.name,
          result: `${TOOL_SCHEMA_RESULT_MARKER}\n\n# Tool Schema Search\n\n_No matching tools found for pattern \`${pattern.replace(/`/g, '\\`')}\`._`,
        };
      }
      const body = hits
        .slice(0, MAX_TOOLS_PER_OVERVIEW_NAMESPACE)
        .map(
          ({ namespace: nsName, entry }) =>
            `### \`${nsName}\`\n${renderShortTool(entry)}`,
        )
        .join('\n');
      const overflow =
        hits.length > MAX_TOOLS_PER_OVERVIEW_NAMESPACE
          ? `\n\n_${hits.length - MAX_TOOLS_PER_OVERVIEW_NAMESPACE} more matches omitted._`
          : '';
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: [
          TOOL_SCHEMA_RESULT_MARKER,
          '',
          `# Tool Schema Search: \`${pattern.replace(/`/g, '\\`')}\``,
          '',
          'Long descriptions below are truncated; use `{namespace, tool}` to read the full schema.',
          '',
          body,
          overflow,
        ].join('\n'),
      };
    }

    // Mode 4: catalog overview (truncated descriptions).
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: [
        TOOL_SCHEMA_RESULT_MARKER,
        '',
        '# Tool Schema Catalog',
        '',
        'Namespaces and their tool names. Read the full schema of a tool with `{namespace, tool}` before invoking it via `tool_invoke`.',
        '',
        renderNamespaceList(catalog),
      ].join('\n'),
    };
  }
}

export const toolSchemaTool = new ToolSchemaTool();

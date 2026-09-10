/**
 * Plan 241 Phase 3: tool_search discovery scanner.
 *
 * Pulls tool names out of the stable Markdown headings emitted by
 * `ToolSearchTool.execute`. Results carry a marker so arbitrary tool
 * output cannot accidentally activate a registered tool.
 */

import type { Message, MessageContent } from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';
import { BUILTIN_TOOLS_NAMESPACE } from '../tool/ToolSchemaTool/catalogFromRegistry.js';

const TOOL_SEARCH_RESULT_MARKER = '<!-- duya-tool-search-result -->';
const TOOL_HEADING_PATTERN = /^## Tool: `([^`]+)`\s*$/gm;

/** Stable marker for the transient discovered-tool schema block. */
export const DISCOVERED_TOOL_SCHEMA_MARKER = '<!-- duya-discovered-tool-schemas -->';

/** Per-tool schema JSON cap, mirroring ToolSchemaTool's truncation contract. */
const MAX_SCHEMA_JSON_CHARS = 24_000;
const TRUNCATED_SCHEMA_SUFFIX = '\n... [schema truncated]';

/**
 * Extract tool names from the Markdown payload produced by
 * `ToolSearchTool.execute`.
 *
 * Returns an empty array when the stable marker or headings are absent.
 * Never throws, so callers may safely scan a mixed tool-result batch.
 */
export function extractToolNamesFromSearchResult(resultText: string): string[] {
  if (!resultText || typeof resultText !== 'string') return [];
  if (!resultText.includes(TOOL_SEARCH_RESULT_MARKER)) return [];

  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of resultText.matchAll(TOOL_HEADING_PATTERN)) {
    const name = match[1]?.trim();
    if (name && !seen.has(name)) {
      names.push(name);
      seen.add(name);
    }
  }
  return names;
}

export function getDiscoveredToolPrompts(
  registry: ToolRegistry,
  toolNames: ReadonlySet<string>,
): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();

  for (const name of toolNames) {
    const executor = registry.getExecutor(name);
    if (!executor?.getPrompt) continue;

    const prompt = executor.getPrompt().trim();
    if (prompt && !seen.has(prompt)) {
      prompts.push(prompt);
      seen.add(prompt);
    }
  }

  return prompts;
}

/**
 * Resolve the namespace a tool belongs to, matching the catalog provider's
 * naming so `tool_invoke({ namespace, tool })` accepts the same value the
 * block advertises: MCP tools use their `mcpInfo.serverName`, every other
 * discoverable tool joins the reserved `builtin` namespace.
 */
function resolveToolNamespace(registry: ToolRegistry, name: string): string {
  if (registry.getOwner(name) === 'mcp') {
    return registry.getTool(name)?.mcpInfo?.serverName ?? 'mcp';
  }
  return BUILTIN_TOOLS_NAMESPACE;
}

/**
 * Plan 480 P3.2 (grok `GetMcpTools` parity): render the full schema of every
 * tool discovered via `tool_search` as a transient conversation-tail block,
 * so the request's `tools` array stays byte-stable (prompt-cache friendly).
 *
 * The model reads each schema here and invokes the tool through the constant
 * `tool_invoke` meta tool (the grok `CallMcpTool` analog). Returns null when
 * no discovered tool is (still) registered.
 *
 * Deterministic: names are sorted, so the block is byte-identical while the
 * discovered set is unchanged.
 */
export function renderDiscoveredToolSchemaBlock(
  registry: ToolRegistry,
  toolNames: ReadonlySet<string>,
): string | null {
  if (toolNames.size === 0) return null;

  const entries: string[] = [];
  for (const name of [...toolNames].sort()) {
    const def = registry.getTool(name);
    if (!def) continue;

    const namespace = resolveToolNamespace(registry, name);
    const parts: string[] = [
      `### \`${name}\``,
      '',
      `Namespace: \`${namespace}\``,
      '',
    ];
    if (def.description) parts.push(def.description.trim(), '');

    let schema: string;
    try {
      schema = JSON.stringify(def.input_schema, null, 2);
    } catch {
      schema = String(def.input_schema);
    }
    if (schema.length > MAX_SCHEMA_JSON_CHARS) {
      schema = schema.slice(0, MAX_SCHEMA_JSON_CHARS) + TRUNCATED_SCHEMA_SUFFIX;
    }
    parts.push('**Input schema:**', '', '```json', schema, '```', '');

    // Usage guide (e.g. BrowserTool.getPrompt) — folded into the tail block
    // instead of the system prompt so the cached prefix is untouched.
    const guide = registry.getExecutor(name)?.getPrompt?.()?.trim();
    if (guide) parts.push(guide, '');

    entries.push(parts.join('\n'));
  }

  if (entries.length === 0) return null;

  return [
    DISCOVERED_TOOL_SCHEMA_MARKER,
    '',
    '# Discovered Tool Schemas',
    '',
    'You found these tools with `tool_search`. Their full schemas are below ' +
      '- they are intentionally NOT in the tool list, so this request\'s prefix stays cache-stable.',
    'Invoke each one with `tool_invoke`: {"namespace": "<namespace>", "tool": "<name>", "arguments": {...}}.',
    '',
    entries.join('\n'),
  ].join('\n');
}

/**
 * Convenience: scan a batch of `tool_result` Message objects and add
 * every discovered tool name into the provided Set. Returns the count
 * of new names added (useful for tests + log lines).
 */
export function harvestDiscoveredTools(
  toolResultMessages: readonly Message[],
  accumulator: Set<string>,
): number {
  let added = 0;
  for (const msg of toolResultMessages) {
    const content = msg.content;

    let text: string | null = null;
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // tool_result content blocks are user-role MessageContent[]; the
      // payload sits in `content.content` for type==='tool_result'.
      const blocks = content as MessageContent[];
      for (const block of blocks) {
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'tool_result') {
          const inner = b.content;
          if (typeof inner === 'string') {
            text = inner;
          } else if (Array.isArray(inner)) {
            text = inner
              .map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
              .join('');
          }
          if (text !== null) break;
        }
      }
    }

    if (text === null) continue;
    const names = extractToolNamesFromSearchResult(text);
    for (const name of names) {
      if (!accumulator.has(name)) {
        accumulator.add(name);
        added++;
      }
      // Plan 418 Phase 4: mark the discovered tool on the tool-result
      // carrier so the provider layer can emit a `tool_reference` block on
      // later turns instead of resending the schema (endpoints that declare
      // supportsToolReferences). Dedupe per message.
      if (!msg.addedToolNames) msg.addedToolNames = [];
      if (!msg.addedToolNames.includes(name)) msg.addedToolNames.push(name);
    }
  }
  return added;
}
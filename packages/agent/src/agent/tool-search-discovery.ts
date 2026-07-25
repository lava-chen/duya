/**
 * Plan 241 Phase 3: tool_search discovery scanner.
 *
 * Pulls tool names out of the stable Markdown headings emitted by
 * `ToolSearchTool.execute`. Results carry a marker so arbitrary tool
 * output cannot accidentally activate a registered tool.
 */

import type { Message, MessageContent } from '../types.js';
import type { ToolRegistry } from '../tool/registry.js';

const TOOL_SEARCH_RESULT_MARKER = '<!-- duya-tool-search-result -->';
const TOOL_HEADING_PATTERN = /^## Tool: `([^`]+)`\s*$/gm;

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
    }
  }
  return added;
}
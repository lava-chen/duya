/**
 * Plan 241: keyword-based tool search over a registry.
 *
 * Scoring rules (highest first wins, ties broken by name asc):
 *   - 100  name === query (exact, case-insensitive)
 *   - 80   name startsWith query
 *   - 60   name.includes query
 *   - 40   description contains query
 *   - 0    otherwise (excluded)
 *
 * Returns only name + description (minimal shape). Full schema via tool_schema.
 */

import type { ToolMeta, ToolRegistry } from '../registry.js';

export function searchToolsFromRegistry(
  registry: ToolRegistry,
  query: string,
  limit: number,
): ToolMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Array<{ meta: ToolMeta; score: number }> = [];
  for (const def of registry.getAllTools()) {
    // `hidden` tools are unreachable by ANY discovery path — tool_search
    // must never surface them (four-tier exposure model).
    if (registry.getExposeMode(def.name) === 'hidden') continue;
    const name = (def.name ?? '').toLowerCase();
    const desc = (def.description ?? '').toLowerCase();

    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (desc.includes(q)) score = 40;

    if (score > 0) {
      scored.push({
        meta: {
          name: def.name,
          description: def.description ?? '',
        },
        score,
      });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.meta.name.localeCompare(b.meta.name);
  });

  const cap = Math.max(0, limit);
  return scored.slice(0, cap).map((s) => s.meta);
}

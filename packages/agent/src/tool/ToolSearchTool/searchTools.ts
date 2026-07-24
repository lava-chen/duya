/**
 * Plan 241 Phase 2: keyword-based tool search over a registry.
 *
 * Scoring rules (highest first wins, ties broken by name asc):
 *   - 100  name === query (exact, case-insensitive)
 *   - 80   name startsWith query
 *   - 60   name.includes query
 *   - 40   description contains query
 *   - 0    otherwise (excluded)
 *
 * Phase 2 change: `inputSchemaSummary` and `exposeMode` are now
 * pulled from the registry's persisted metadata (set via the third
 * arg of `ToolRegistry.register`). Tools registered without meta
 * default to `exposeMode: undefined` (treated as `'always'`) and
 * `inputSchemaSummary: undefined`. The `category` field remains a
 * constant `'other'` until the registry carries a real category.
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
    const name = (def.name ?? '').toLowerCase();
    const desc = (def.description ?? '').toLowerCase();

    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (desc.includes(q)) score = 40;

    if (score > 0) {
      const meta = registry.getMeta(def.name);
      scored.push({
        meta: {
          name: def.name,
          description: def.description ?? '',
          category: 'other',
          inputSchemaSummary: meta?.inputSchemaSummary,
          exposeMode: meta?.exposeMode,
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

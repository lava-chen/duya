// Build the collapsed header text for a tool group.
//
// Counts each tool by its coarse-grained category (`commands` /
// `editFiles` / `readFiles` / `search` / `browser` / `agent` / `ask` /
// `memory` / `skill` / catch-all `tools`), looks up the matching
// singular/plural i18n template, and joins the rendered parts in a
// stable order. When the group has more than MAX_PARTS_BEFORE_TRUNCATE
// distinct categories, head parts are rendered verbatim and the rest
// are folded into a "+N more" tail.
//
// Pure function — no React, no side effects. Safe to unit test in
// isolation; the existing ToolActionsGroup.test.tsx asserts on this
// output, so behaviour here must stay byte-identical to the inline
// version that lived in ToolActionsGroup.tsx.

import type { TranslationKey } from '@/i18n';
import { classifyToolForSummary } from '../classify';
import type { SummaryCategoryKey, ToolAction } from '../types';

// When a group spans more than this many distinct categories, the
// header is truncated to N parts and a "+N more" tail covers the rest.
const MAX_PARTS_BEFORE_TRUNCATE = 3;

interface SummaryPart {
  count: number;
  categoryKey: SummaryCategoryKey;
}

function templateKeyFor(categoryKey: SummaryCategoryKey, count: number): string {
  const variant = count === 1 ? 'one' : 'other';
  return `streaming.toolAction.groupSummary.${categoryKey}.${variant}`;
}

export function buildGroupSummary(
  tools: ToolAction[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  const counts = new Map<SummaryCategoryKey, SummaryPart>();
  for (const tool of tools) {
    const part = classifyToolForSummary(tool);
    if (!part) continue;
    const existing = counts.get(part.categoryKey);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(part.categoryKey, { count: 1, categoryKey: part.categoryKey });
    }
  }

  // Preserve a stable order so the header doesn't shuffle when streaming
  // updates reorder the inner tools. Order matches the category table in
  // the plan: commands → edit → read → search → browser → agent → ask →
  // memory → catch-all tools.
  const order: SummaryCategoryKey[] = [
    'commands',
    'editFiles',
    'readFiles',
    'search',
    'browser',
    'agent',
    'ask',
    'memory',
    'skill',
    'tools',
  ];
  const parts: SummaryPart[] = [];
  for (const key of order) {
    const p = counts.get(key);
    if (p) parts.push(p);
  }

  if (parts.length === 0) {
    return locale === 'zh'
      ? `执行了 ${tools.length} 项操作`
      : `${tools.length} actions`;
  }

  const renderedParts = parts.map((p) =>
    t(templateKeyFor(p.categoryKey, p.count) as TranslationKey, { count: p.count }),
  );

  if (renderedParts.length > MAX_PARTS_BEFORE_TRUNCATE) {
    const head = renderedParts.slice(0, MAX_PARTS_BEFORE_TRUNCATE);
    const remaining = renderedParts.length - MAX_PARTS_BEFORE_TRUNCATE;
    const sep = locale === 'zh' ? '，' : ', ';
    return `${head.join(sep)}${sep}${t('streaming.toolAction.groupSummary.andMore', { count: remaining })}`;
  }

  const sep = locale === 'zh' ? '，' : ', ';
  return renderedParts.join(sep);
}

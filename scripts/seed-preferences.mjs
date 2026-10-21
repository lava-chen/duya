#!/usr/bin/env node
/**
 * seed-preferences.mjs
 *
 * One-shot deterministic backfill: extract the `preference:*` signals that
 * are buried inside `global/areas/*.md` and fold them into
 * `global/preferences/<group>.md` files (Plan 417 dimension fix).
 *
 * Until now the curator folded every claim type into `global/areas/` and
 * never split out `preference` / `person`. This script recovers the
 * preferences that already exist in the area files so the preferences
 * directory (and the MEMORY.md projection) has real content immediately,
 * without needing an LLM call (MiniMax is rate-limited at the time of
 * writing).
 *
 * Heuristic: every `preference:<slug>` token in an area file, plus the
 * sentence context around it, becomes one preference bullet. Bullets are
 * deduplicated by slug and grouped by theme:
 *
 *   communication   — reply style, honesty, depth, when to ask
 *   tool-use        — tool call discipline, fabrication, retry rules
 *   canvas          — canvas-specific behavior
 *   verification    — visual / empirical verification rules
 *   workflow        — everything else (ports, topologies, probe rules)
 *
 * Idempotent: re-running rewrites the same files from the same source.
 *
 * Usage:
 *   node scripts/seed-preferences.mjs                # live root
 *   node scripts/seed-preferences.mjs --root <dir>    # override (tests)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || '', '.duya', 'memory');

const GROUPS = [
  { name: 'communication', match: /(prose|honest|depth|ask|destructive|irreversible|language|style|format|halt|drift|repeat|summar)/i },
  { name: 'tool-use', match: /(fabricat|empty|probe|disclos|retry|attempt|report|feasib|verif.*tool|concept)/i },
  { name: 'canvas', match: /(canvas|widget|topolog|star|scratchpad|orchestrator|element)/i },
  { name: 'verification', match: /(visual|assert|screenshot|evaluate|backend|clone|static)/i },
];

function themeFor(slug) {
  for (const g of GROUPS) if (g.match.test(slug)) return g.name;
  return 'workflow';
}

/** Extract a compact one-line description from the lines around a token. */
function contextFor(lines, idx) {
  const pick = [];
  for (let i = Math.max(0, idx - 1); i <= Math.min(lines.length - 1, idx + 1); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Drop list-bullet prefixes and leading `- `.
    pick.push(line.replace(/^[-*]\s+/, '').replace(/^##?\s+.*$/, ''));
  }
  // Prefer the line containing the token, else the joined context.
  const tokenLine = lines[idx]?.trim().replace(/^[-*]\s+/, '') ?? '';
  const compact = tokenLine.length > 0 ? tokenLine : pick.join(' ');
  return compact.length > 260 ? compact.slice(0, 260) + '…' : compact;
}

function collect(root) {
  const areasDir = path.join(root, 'global', 'areas');
  if (!existsSync(areasDir)) return new Map();

  const bySlug = new Map(); // slug -> { theme, descs: Set<string>, source: string }
  for (const name of readdirSync(areasDir)) {
    if (!name.endsWith('.md') || name === 'index.md') continue;
    const body = readFileSync(path.join(areasDir, name), 'utf8');
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /preference:([a-z0-9-]+)/.exec(lines[i]);
      if (!m) continue;
      const slug = m[1];
      const desc = contextFor(lines, i);
      const rec = bySlug.get(slug) ?? { theme: themeFor(slug), descs: new Set(), sources: new Set() };
      rec.descs.add(desc);
      rec.sources.add(name.replace(/\.md$/, ''));
      bySlug.set(slug, rec);
    }
  }
  return bySlug;
}

function main() {
  const args = process.argv.slice(2);
  const root = args.includes('--root')
    ? args[args.indexOf('--root') + 1]
    : DEFAULT_ROOT;

  const bySlug = collect(root);
  if (bySlug.size === 0) {
    console.log(`No preference:* tokens found under ${root}/global/areas — nothing to seed.`);
    return;
  }

  // Group slugs by theme, sorted by slug within theme.
  const byTheme = new Map();
  for (const [slug, rec] of bySlug) {
    const arr = byTheme.get(rec.theme) ?? [];
    arr.push({ slug, rec });
    byTheme.set(rec.theme, arr);
  }
  for (const arr of byTheme.values()) arr.sort((a, b) => a.slug.localeCompare(b.slug));

  const prefsDir = path.join(root, 'global', 'preferences');
  mkdirSync(prefsDir, { recursive: true });

  let written = 0;
  for (const [theme, items] of byTheme) {
    const title = theme[0].toUpperCase() + theme.slice(1);
    const lines = [
      `# ${title} preferences`,
      '',
      '## Summary',
      '',
      `${title} preferences distilled from past sessions — ${items.length} durable rule(s).`,
      '',
      '## Details',
      '',
    ];
    for (const { slug, rec } of items) {
      const desc = [...rec.descs][0] ?? slug;
      lines.push(`- **preference:${slug}**: ${desc}`);
    }
    lines.push('');
    const target = path.join(prefsDir, `${theme}.md`);
    writeFileSync(target, lines.join('\n'), 'utf8');
    written += 1;
  }

  console.log(`Seeded ${bySlug.size} preference(s) into ${written} file(s) under ${prefsDir}`);
  for (const [theme, items] of byTheme) {
    console.log(`  ${theme}: ${items.length}`);
  }
}

try {
  main();
} catch (err) {
  console.error('seed-preferences failed:', err);
  process.exit(1);
}
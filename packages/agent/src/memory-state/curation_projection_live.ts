/**
 * Memory projection generator — live layout (Plan 417).
 *
 * Reads canonical files from the **live** memory root layout that
 * the curation agent actually writes:
 *
 *   <memoryRoot>/global/areas/<slug>.md    — `area` claim type
 *   <memoryRoot>/global/people/<slug>.md   — `person` claim type
 *
 * Each file has no YAML frontmatter; metadata is derived from:
 *   - directory (`global/areas` → claim_type=`area`,
 *     `global/people` → claim_type=`person`)
 *   - filename (`crest-hydrology.md` → canonical_key=`crest-hydrology`)
 *   - H1 title (`# Cresting Computation Hydrology Model` → display title)
 *
 * Outputs (Plan 417 Task H, refreshes the files the agent reads at
 * prompt-build time):
 *   - MEMORY.md        — searchable registry, one line per active file
 *   - summary.md       — bounded routing summary (top 12 by recency)
 *   - global/areas/index.md — directory listing
 *   - global/people/index.md — directory listing
 *
 * Functions are pure with respect to the filesystem at call time:
 * same files on disk always produce byte-identical output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_BYTES = 64 * 1024;
const MAX_SUMMARY_CHARS = 6_000;
const SUMMARY_TOP_N = 12;
const TRUNCATION_MARKER = '\n<!-- truncated -->';

interface CanonicalFile {
  /** Canonical key (e.g. `area:crest-hydrology-model-study`). */
  canonicalKey: string;
  /** Claim type directory name (e.g. `area`, `person`). */
  claimType: string;
  /** First H1 title for human-readable display. */
  title: string;
  /** First paragraph (truncated to 200 chars) for the registry line. */
  firstParagraph: string;
  /** Path relative to memoryRoot (forward-slash separators). */
  relPath: string;
  /** File mtime in ms (used for sorting summary by recency). */
  mtimeMs: number;
}

interface LayoutEntry {
  type: 'area' | 'person';
  dir: string;
}

const LAYOUT: ReadonlyArray<LayoutEntry> = [
  { type: 'area', dir: 'global/areas' },
  { type: 'person', dir: 'global/people' },
];

/** Extract the H1 title (first `# ` heading) or `''` if none. */
function extractTitle(body: string): string {
  for (const line of body.split('\n')) {
    const m = /^#\s+(.+)$/.exec(line);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/**
 * Extract the Summary section of a canonical record.
 *
 * Canonical files use the shape `# title` → `## Summary` → prose →
 * `## Details`. The Summary section is the bounded description a future
 * session should read first; Details is the deep dump and stays in the
 * file. We prefer the `## Summary` body, falling back to the first
 * non-title, non-comment paragraph when the section header is absent.
 */
function extractSummary(body: string): string {
  const lines = body.split('\n');
  const trimmed = lines.map((l) => l.trim());

  // Find `## Summary` (case-insensitive) and collect prose until the
  // next heading of level >= 2.
  let summaryIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    if (/^#{2,}\s+summary\b/i.test(trimmed[i])) {
      summaryIdx = i;
      break;
    }
  }
  if (summaryIdx >= 0) {
    const para: string[] = [];
    for (let i = summaryIdx + 1; i < trimmed.length; i++) {
      const line = trimmed[i];
      if (/^#{1,}\s/.test(line)) break;
      if (line === '' || /^<!--/.test(line) || /^-->/.test(line)) continue;
      para.push(line);
    }
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 0) return text;
  }

  // Fallback: first non-title, non-comment paragraph (legacy files
  // without a Summary header, e.g. a stray auto-generated comment).
  const para: string[] = [];
  let sawTitle = false;
  let started = false;
  for (const line of trimmed) {
    if (!sawTitle && /^#\s+/.test(line)) { sawTitle = true; continue; }
    if (line === '' || /^<!--/.test(line) || /^-->/.test(line)) {
      if (started) break;
      continue;
    }
    if (/^#{2,}\s/.test(line)) break;
    started = true;
    para.push(line);
  }
  const text = para.join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

/** Read every canonical file under the configured layout. */
function readLiveFiles(memoryRoot: string): CanonicalFile[] {
  const out: CanonicalFile[] = [];
  for (const entry of LAYOUT) {
    const dir = path.join(memoryRoot, entry.dir);
    if (!fs.existsSync(dir)) continue;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      if (name === 'index.md') continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const body = fs.readFileSync(full, 'utf8');
      const slug = name.replace(/\.md$/, '');
      out.push({
        canonicalKey: `${entry.type}:${slug}`,
        claimType: entry.type,
        title: extractTitle(body),
        firstParagraph: extractSummary(body),
        // Use forward slashes regardless of platform (output is markdown
        // and gets copied between Windows + Linux dev machines).
        relPath: `${entry.dir}/${name}`.replace(/\\/g, '/'),
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  return out;
}

/** Sort by mtime DESC (most recent first) — used for `summary.md`. */
function sortByRecencyDesc(files: CanonicalFile[]): CanonicalFile[] {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Sort by canonical_key ASC within claim_type groups. */
function sortByKey(files: CanonicalFile[]): CanonicalFile[] {
  return [...files].sort((a, b) => {
    if (a.claimType !== b.claimType) return a.claimType.localeCompare(b.claimType);
    return a.canonicalKey.localeCompare(b.canonicalKey);
  });
}

/** Truncate a string at `max` bytes (UTF-8 boundary safe) and append a marker. */
function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const buf = Buffer.from(s, 'utf8');
  // Walk back from `max` until we land on a UTF-8 boundary (start byte).
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString('utf8') + TRUNCATION_MARKER;
}

/** Truncate a string at `max` characters, preserving word boundaries when possible. */
function truncateChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max - 80 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// MEMORY.md
// ---------------------------------------------------------------------------

/**
 * Generate the searchable `MEMORY.md` projection from the live layout.
 *
 * - One line per canonical file, grouped by claim_type.
 * - Truncated to 64 KiB with a marker.
 */
export function generateMemoryMdLive(memoryRoot: string): string {
  const files = readLiveFiles(memoryRoot);
  if (files.length === 0) return '';

  const sorted = sortByKey(files);
  const lines: string[] = [
    '# Durable Memory',
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2 (live layout). Do not edit. -->',
    '',
  ];

  let currentType = '';
  for (const f of sorted) {
    if (f.claimType !== currentType) {
      currentType = f.claimType;
      lines.push(`## ${currentType}`);
      lines.push('');
    }
    const desc = f.firstParagraph.length > 0 ? f.firstParagraph : f.title;
    // Inline a bounded summary so MEMORY.md is a readable digest, not a
    // bare filename index (Plan 417 follow-up: Codex-memory style).
    const inline = truncateChars(desc, 400);
    lines.push(`- **${f.canonicalKey}**: ${inline} → ${f.relPath}`);
  }
  lines.push('');

  return truncateBytes(lines.join('\n'), MAX_BYTES);
}

// ---------------------------------------------------------------------------
// summary.md
// ---------------------------------------------------------------------------

/**
 * Generate the bounded `summary.md` projection.
 *
 * Top N files by recency (most recently modified first). Bounded to
 * 6 000 chars so it stays safe to inline into the agent prompt.
 */
export function generateSummaryMdLive(memoryRoot: string): string {
  const files = readLiveFiles(memoryRoot);
  if (files.length === 0) {
    return '';
  }
  const recent = sortByRecencyDesc(files).slice(0, SUMMARY_TOP_N);

  const header = [
    '# Memory Summary',
    '',
    'This is a bounded routing summary. Search `MEMORY.md` for full details.',
    '',
    '## Essentials',
    '',
  ].join('\n');

  const body = recent
    .map((f) => {
      const desc = f.firstParagraph.length > 0 ? f.firstParagraph : f.title;
      const inline = truncateChars(desc, 300);
      return `- [${f.claimType}] ${inline}`;
    })
    .join('\n');

  return truncateChars(header + body + '\n', MAX_SUMMARY_CHARS);
}

// ---------------------------------------------------------------------------
// index.md per entity directory
// ---------------------------------------------------------------------------

/**
 * Generate `global/<type>/index.md` listing every file under that dir.
 *
 * Returns `''` when the directory doesn't exist or is empty, so the
 * caller can skip the write.
 */
export function generateIndexMdLive(memoryRoot: string, entityType: 'area' | 'person'): string {
  const entry = LAYOUT.find((l) => l.type === entityType);
  if (!entry) return '';
  const dir = path.join(memoryRoot, entry.dir);
  if (!fs.existsSync(dir)) return '';

  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'index.md');

  const lines: string[] = [
    `# ${entityType === 'area' ? 'Areas' : 'People'} Index`,
    '',
    'This file is automatically generated by DUYA Memory. Do not edit.',
    '',
  ];

  for (const name of names.sort()) {
    lines.push(`- [${name.replace(/\.md$/, '')}](./${name})`);
  }
  lines.push('');

  return lines.join('\n');
}
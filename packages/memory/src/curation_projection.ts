import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic projection generators for Memory Phase 2 (design §10.2).
 *
 * The agent maintains normalized canonical files under
 * `memory/items/<claim_type>/<slug>.md` and `memory/entities/<type>/<slug>.md`.
 * This module reads those files and renders the three code-generated
 * projections: MEMORY.md (searchable index), summary.md (bounded routing),
 * and per-entity-type index.md.
 *
 * All functions are pure with respect to the filesystem state at call
 * time — same files on disk always produce byte-identical output.
 */

// ---------------------------------------------------------------------------
// Hard limits (design §10.2)
// ---------------------------------------------------------------------------

export const MEMORY_MD_MAX_BYTES = 64 * 1024;
export const SUMMARY_MD_MAX_CHARS = 6_000;
export const SUMMARY_TOP_N = 12;

const TRUNCATION_MARKER = '\n<!-- truncated -->';

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter block delimited by `---` lines.
 *
 * This is NOT a full YAML parser — it handles only the flat `key: value`
 * shape used by canonical memory files (design §4.1). Values may be:
 *   - double-quoted strings: `key: "value"`
 *   - unquoted scalars: `key: value`
 *   - booleans: `key: true` / `key: false`
 *   - null: `key: null`
 *
 * Returns `{ frontmatter, body }` where `body` is everything after the
 * closing `---`. If no frontmatter delimiters are present, returns an
 * empty frontmatter object and the full content as body.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | boolean | null>;
  body: string;
} {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing delimiter.
  const firstDelimEnd = content.indexOf('\n');
  const afterFirst = content.slice(firstDelimEnd + 1);
  const closeIdx = afterFirst.search(/^---\s*$/m);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = afterFirst.slice(0, closeIdx);
  const bodyStart = afterFirst.indexOf('\n', closeIdx + 3);
  const body = bodyStart === -1 ? '' : afterFirst.slice(bodyStart + 1);

  const frontmatter: Record<string, string | boolean | null> = {};
  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | boolean | null = trimmed.slice(colonIdx + 1).trim();

    // Strip double quotes.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    } else if (value === 'null') {
      value = null;
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

interface CanonicalFile {
  relPath: string;       // relative to memoryRoot, posix-style
  canonicalKey: string;
  claimType: string;
  status: string;
  importance: string;
  summaryEligible: boolean;
  updatedAt: string;
  body: string;
}

function readCanonicalFiles(memoryRoot: string): CanonicalFile[] {
  const files: CanonicalFile[] = [];

  for (const sub of ['items', 'entities']) {
    const subDir = path.join(memoryRoot, sub);
    if (!fs.existsSync(subDir)) continue;
    walkMarkdown(subDir, memoryRoot, files);
  }

  return files;
}

function walkMarkdown(dir: string, memoryRoot: string, out: CanonicalFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip symlinks (path-escape defense).
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(fullPath, memoryRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
      const content = fs.readFileSync(fullPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relPath = path.relative(memoryRoot, fullPath).split(path.sep).join('/');
      out.push({
        relPath,
        canonicalKey: String(frontmatter.canonical_key ?? ''),
        claimType: String(frontmatter.claim_type ?? ''),
        status: String(frontmatter.status ?? 'active'),
        importance: String(frontmatter.importance ?? 'normal'),
        summaryEligible: frontmatter.summary_eligible === true,
        updatedAt: String(frontmatter.updated_at ?? ''),
        body,
      });
    }
  }
}

/**
 * Extract the first paragraph from the markdown body: skip the H1 title
 * and any blank lines, then take text until the next blank line or heading.
 */
function firstParagraph(body: string): string {
  const lines = body.split('\n');
  let started = false;
  const paraLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) continue; // skip H1 title
    if (line.trim() === '') {
      if (started) break;
      continue;
    }
    if (line.startsWith('#')) break; // any heading after paragraph started
    started = true;
    paraLines.push(line.trim());
  }
  return paraLines.join(' ');
}

// ---------------------------------------------------------------------------
// generateMemoryMd (design §10.2)
// ---------------------------------------------------------------------------

/**
 * Generate the searchable `MEMORY.md` projection.
 *
 * - One line per active canonical file (status != 'retired').
 * - Sectioned by `claim_type` (alphabetical), sorted by `canonical_key` within section.
 * - Line format: `- **<canonical_key>**: <first paragraph> → <relative path>`
 * - Hard cap: 64 KiB. Truncated with `<!-- truncated -->` marker.
 */
export function generateMemoryMd(memoryRoot: string): string {
  const files = readCanonicalFiles(memoryRoot);
  const active = files.filter((f) => f.status !== 'retired' && f.canonicalKey);

  if (active.length === 0) return '';

  // Group by claim_type.
  const byClaimType = new Map<string, CanonicalFile[]>();
  for (const f of active) {
    const arr = byClaimType.get(f.claimType) ?? [];
    arr.push(f);
    byClaimType.set(f.claimType, arr);
  }

  const claimTypes = [...byClaimType.keys()].sort();
  const lines: string[] = [
    '# Durable Memory',
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const ct of claimTypes) {
    const sectionFiles = byClaimType.get(ct)!.sort((a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey)
    );
    lines.push(`## ${ct}`);
    lines.push('');
    for (const f of sectionFiles) {
      const para = firstParagraph(f.body);
      lines.push(`- **${f.canonicalKey}**: ${para} → ${f.relPath}`);
    }
    lines.push('');
  }

  let result = lines.join('\n');

  // Truncate at 64 KiB.
  if (Buffer.byteLength(result, 'utf8') > MEMORY_MD_MAX_BYTES) {
    // Truncate by character count approximating the byte cap.
    const maxChars = MEMORY_MD_MAX_BYTES;
    result = result.slice(0, maxChars);
    // Cut at last newline to avoid partial lines.
    const lastNl = result.lastIndexOf('\n');
    if (lastNl > 0) result = result.slice(0, lastNl);
    result += TRUNCATION_MARKER;
  }

  return result;
}

// ---------------------------------------------------------------------------
// generateSummaryMd (design §10.2)
// ---------------------------------------------------------------------------

const IMPORTANCE_RANK: Record<string, number> = {
  essential: 0,
  high: 1,
  normal: 2,
};

/**
 * Generate the bounded `summary.md` routing layer.
 *
 * Ranking (deterministic, code-only):
 *   1. Filter: status='active' AND summary_eligible=true
 *   2. Sort by importance (essential > high > normal)
 *   3. Within same importance, sort by updated_at descending
 *   4. Stable tie-break by canonical_key ascending
 *   5. Take top 12, render each as `- **<canonical_key>**: <summary>`
 *   6. Hard cap: 6000 characters
 */
export function generateSummaryMd(memoryRoot: string): string {
  const files = readCanonicalFiles(memoryRoot);
  const eligible = files.filter(
    (f) => f.status === 'active' && f.summaryEligible && f.canonicalKey
  );

  if (eligible.length === 0) return '';

  const sorted = eligible.sort((a, b) => {
    const rankA = IMPORTANCE_RANK[a.importance] ?? 2;
    const rankB = IMPORTANCE_RANK[b.importance] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    // updated_at descending.
    const timeCmp = b.updatedAt.localeCompare(a.updatedAt);
    if (timeCmp !== 0) return timeCmp;
    // canonical_key ascending.
    return a.canonicalKey.localeCompare(b.canonicalKey);
  });

  const top = sorted.slice(0, SUMMARY_TOP_N);
  const lines: string[] = [
    '# Memory Summary',
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const f of top) {
    const summary = firstParagraph(f.body);
    lines.push(`- **${f.canonicalKey}**: ${summary}`);
  }

  let result = lines.join('\n');

  if (result.length > SUMMARY_MD_MAX_CHARS) {
    result = result.slice(0, SUMMARY_MD_MAX_CHARS);
    const lastNl = result.lastIndexOf('\n');
    if (lastNl > 0) result = result.slice(0, lastNl);
    result += '\n<!-- truncated -->';
  }

  return result;
}

// ---------------------------------------------------------------------------
// generateIndexMd (design §10.2)
// ---------------------------------------------------------------------------

/**
 * Generate `entities/<entityType>/index.md` — a list of entity files
 * in the given entity type directory, sorted by slug.
 *
 * Each line: `- [<display name>](<relative path>)`
 *
 * The display name is extracted from the file's H1 title (`# Title`);
 * if no H1 is found, the slug (with dashes replaced by spaces) is used.
 * The relative path is `./<slug>.md` (relative to the index.md location).
 */
export function generateIndexMd(memoryRoot: string, entityType: string): string {
  const entityDir = path.join(memoryRoot, 'entities', entityType);
  if (!fs.existsSync(entityDir)) return '';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(entityDir, { withFileTypes: true });
  } catch {
    return '';
  }

  interface IndexEntry {
    slug: string;
    displayName: string;
  }

  const indexEntries: IndexEntry[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'index.md') continue;

    const slug = entry.name.slice(0, -3); // strip .md
    const fullPath = path.join(entityDir, entry.name);
    const content = fs.readFileSync(fullPath, 'utf8');
    const { body } = parseFrontmatter(content);

    // Extract H1 title.
    let displayName = slug.replace(/-/g, ' ');
    for (const line of body.split('\n')) {
      if (line.startsWith('# ')) {
        displayName = line.slice(2).trim();
        break;
      }
      if (line.trim() !== '' && !line.startsWith('#')) break;
    }

    indexEntries.push({ slug, displayName });
  }

  if (indexEntries.length === 0) return '';

  indexEntries.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines: string[] = [
    `# ${entityType} index`,
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const e of indexEntries) {
    lines.push(`- [${e.displayName}](./${e.slug}.md)`);
  }

  return lines.join('\n');
}
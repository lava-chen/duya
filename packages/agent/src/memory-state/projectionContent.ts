/**
 * Deterministic projection content rendering (Plan 303 Phase C, design v3
 * D11/D12).
 *
 * This module is the single source of truth for what the L1 file
 * projection SHOULD contain for a given DB state:
 *   - `rollout_summaries/<derived-filename>.md` per Stage 1 row
 *   - one bounded `summary.md` routing layer
 *   - one unified `MEMORY.md` searchable layer
 *
 * `reconcile.ts` compares disk against these renderings; Plan 304's
 * writer will align to this module so the write path and the reconcile
 * path can never drift apart. Rendering is pure (no I/O, no clock) so
 * the same input always produces byte-identical output.
 */

/**
 * Authoritative `stage1_outputs` row shape, mirroring migrations 0002
 * (base table) and 0003 (`content_hash_at_write`, nullable for rows
 * written before that migration).
 */
export interface Stage1OutputRow {
  rollout_id: string;
  thread_id: string;
  cwd: string;
  project_id: string;
  git_branch: string | null;
  job_status: string;
  content_outcome: string | null;
  rollout_summary: string | null;
  raw_memory: string | null;
  rollout_slug: string;
  generated_at: number;
  source_updated_at: number;
  source_content_hash: string;
  extracted_through_seq: number | null;
  output_updated_at: number;
  schema_version: number;
  content_hash_at_write: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * UTC timestamp in the Windows-safe D11 shape: `<YYYY-MM-DD>T<HH-MM-SS>`
 * (colons are illegal in Windows filenames).
 */
function formatUtcFilenameTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}`
  );
}

/** First 8 hex chars of the rollout id (dashes stripped), lowercased. */
export function rolloutShortId(rolloutId: string): string {
  return rolloutId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/**
 * Sanitize a slug to `[a-z0-9-]{3,80}`: lowercase, every illegal char
 * becomes '-', truncated to 80 chars. Anything that cannot reach the
 * 3-char minimum falls back to 'rollout'.
 */
export function sanitizeRolloutSlug(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 80);
  return cleaned.length >= 3 ? cleaned : 'rollout';
}

/**
 * D11 filename (aligned to the Codex on-disk shape):
 * `<YYYY-MM-DD>T<HH-MM-SS>-<shortid>-<slug>.md` in UTC, where shortid is
 * the first 8 hex chars of the dash-stripped rollout id.
 *
 * Note: project_id is intentionally omitted from the frontmatter. The
 * memory system is global-only; the column remains in the DB for
 * backward compatibility but is always written as 'global'.
 */
export function deriveRolloutSummaryFilename(
  row: Pick<Stage1OutputRow, 'rollout_id' | 'rollout_slug' | 'generated_at'>
): string {
  return (
    `${formatUtcFilenameTimestamp(row.generated_at)}-` +
    `${rolloutShortId(row.rollout_id)}-${sanitizeRolloutSlug(row.rollout_slug)}.md`
  );
}

/**
 * Quote a scalar as a YAML-safe double-quoted string. JSON string
 * quoting is a valid subset of YAML double-quoted scalars, and it is
 * fully deterministic.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Deterministic rollout summary file content (Plan 304 Phase C, design
 * v3 实物对照表): the Codex-superset frontmatter shape — Codex's
 * `thread_id / updated_at / rollout_path / cwd / git_branch` extended
 * with the DUYA fields, where Codex's `rollout_path` (their jsonl
 * source) is replaced by `source_table` (our source is the main DB) —
 * followed by a blank line and the summary body (empty string when
 * NULL).
 */
export function renderRolloutSummaryFile(row: Stage1OutputRow): string {
  const frontmatter = [
    '---',
    `thread_id: ${yamlString(row.thread_id)}`,
    `updated_at: ${yamlString(new Date(row.generated_at).toISOString())}`,
    `source_table: ${yamlString('duya-main.db:chat_sessions')}`,
    `cwd: ${yamlString(row.cwd)}`,
    `git_branch: ${row.git_branch === null ? 'null' : yamlString(row.git_branch)}`,
    `rollout_id: ${yamlString(row.rollout_id)}`,
    `job_status: ${yamlString(row.job_status)}`,
    `content_outcome: ${row.content_outcome === null ? 'null' : yamlString(row.content_outcome)}`,
    `source_content_hash: ${yamlString(row.source_content_hash)}`,
    `schema_version: ${row.schema_version}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${row.rollout_summary ?? ''}`;
}

// ---------------------------------------------------------------------------
// Phase 2 renderers (Plan 306 Phase B)
// ---------------------------------------------------------------------------

/**
 * Authoritative `memory_entries` row shape, mirroring migration 0005.
 * The memory system is global-only; project_id remains nullable in the
 * DB for backward compatibility but is always NULL for new entries.
 */
export interface MemoryEntryRow {
  memory_id: string;
  scope: 'global';
  project_id: string | null;
  kind: 'preference' | 'fact' | 'reference' | 'procedure' | 'person' | 'area';
  canonical_key: string;
  content: string;
  version: number;
  status: 'active' | 'superseded' | 'retired';
  created_at: number;
  updated_at: number;
}

/**
 * Authoritative `projects` row shape (migration 0001).
 * Kept for DB compatibility but no longer used by memory projections.
 */
export interface ProjectRow {
  project_id: string;
  canonical_root: string;
  created_at: number;
  last_seen_at: number;
}

export interface Phase2DiffEntry {
  memory_id: string;
  canonical_key: string;
  content: string;
  kind: string;
  scope: 'global';
  project_id: string | null;
}

export interface Phase2Diff {
  added: Phase2DiffEntry[];
  superseded: Phase2DiffEntry[];
  retired: Phase2DiffEntry[];
  runId: number;
  inputHash: string;
  timestamp: number;
}

/** Hard limits keep the always-read summary from growing with history. */
export const MEMORY_SUMMARY_MAX_CHARS = 6_000;
const MEMORY_SUMMARY_GLOBAL_LIMIT = 12;
const MEMORY_SUMMARY_CLAIM_MAX_CHARS = 220;

/** Codex MEMORY.md section titles in deterministic document order. */
const MEMORY_FILE_SECTIONS = [
  'User preferences',
  'Reusable knowledge',
  'Failures and how to do differently',
] as const;

function kindToMemorySection(
  kind: MemoryEntryRow['kind']
): (typeof MEMORY_FILE_SECTIONS)[number] | null {
  switch (kind) {
    case 'preference':
      return 'User preferences';
    case 'fact':
    case 'procedure':
    case 'reference':
      return 'Reusable knowledge';
    default:
      return null;
  }
}

function maxUpdatedAt(entries: MemoryEntryRow[]): number {
  if (entries.length === 0) return 0;
  return entries.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), 0);
}

function renderCodexMemorySections(entries: MemoryEntryRow[], headingLevel = 2): string[] {
  const active = entries.filter((e) => e.status === 'active');
  const lines: string[] = [];
  const heading = '#'.repeat(headingLevel);

  for (const section of MEMORY_FILE_SECTIONS) {
    const sectionEntries = active
      .filter((e) => kindToMemorySection(e.kind) === section)
      .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));

    lines.push('');
    lines.push(`${heading} ${section}`);

    if (sectionEntries.length === 0) {
      lines.push('');
      lines.push('_(none)_');
    } else {
      for (const entry of sectionEntries) {
        lines.push('');
        lines.push(`- **${entry.canonical_key}** (v${entry.version}): ${entry.content}`);
      }
    }
  }

  return lines;
}

/**
 * Render the single searchable `MEMORY.md` projection. The memory system
 * is global-only; there are no per-project sections or files.
 */
export function renderUnifiedMemoryFile(entries: MemoryEntryRow[]): string {
  const active = entries.filter((entry) => entry.status === 'active');
  const lines: string[] = [
    '# Durable Memory',
    '',
    '<!-- Auto-generated by DUYA Memory v2. Do not edit. Search with rg; do not edit. -->',
    '',
  ];

  lines.push(...renderCodexMemorySections(active, 2));
  return lines.join('\n');
}

function summaryPriority(entry: MemoryEntryRow): number {
  if (entry.canonical_key.startsWith('ad-hoc:')) return 1_000;
  switch (entry.kind) {
    case 'preference':
      return 500;
    case 'procedure':
      return 400;
    case 'fact':
      return 300;
    case 'reference':
      return 200;
    default:
      return 0;
  }
}

function appendSummaryLine(lines: string[], line: string): boolean {
  const nextLength = lines.reduce((total, value) => total + value.length + 1, 0) + line.length + 1;
  if (nextLength > MEMORY_SUMMARY_MAX_CHARS) return false;
  lines.push(line);
  return true;
}

function compactSummaryText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Render the bounded `summary.md` routing layer. It contains useful claims,
 * not a linear dump of canonical keys, and its size is independent of the
 * total number of memories after the configured caps are reached.
 */
export function renderMemorySummaryFile(entries: MemoryEntryRow[]): string {
  const active = entries.filter((e) => e.status === 'active');
  const updatedMs = maxUpdatedAt(active);
  const updatedIso = updatedMs > 0 ? new Date(updatedMs).toISOString() : 'never';

  const lines: string[] = [
    '# Memory Summary',
    '',
    `Updated: ${updatedIso}`,
    '',
    'This is a bounded routing summary. Search `MEMORY.md` for full details.',
    '',
    '## Essentials',
  ];

  const essentials = active
    .filter((entry) => kindToMemorySection(entry.kind) !== null)
    .sort((a, b) => summaryPriority(b) - summaryPriority(a) || b.updated_at - a.updated_at)
    .slice(0, MEMORY_SUMMARY_GLOBAL_LIMIT);
  if (essentials.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of essentials) {
      const content = compactSummaryText(entry.content, MEMORY_SUMMARY_CLAIM_MAX_CHARS);
      if (!appendSummaryLine(lines, `- [${entry.kind}] ${content}`)) break;
    }
  }

  return lines.join('\n');
}

/**
 * Render `phase2_workspace_diff.md` — ingest/forget queue showing
 * added/superseded/retired entries since the last run.
 */
export function renderPhase2WorkspaceDiff(diff: Phase2Diff): string {
  const lines: string[] = [
    '# Phase 2 Workspace Diff',
    '',
    `Run ID: ${diff.runId}`,
    `Input Hash: ${diff.inputHash}`,
    `Timestamp: ${new Date(diff.timestamp).toISOString()}`,
    '',
    `## Added (${diff.added.length})`,
  ];

  if (diff.added.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of diff.added) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
    }
  }

  lines.push('');
  lines.push(`## Superseded (${diff.superseded.length})`);
  if (diff.superseded.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of diff.superseded) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
    }
  }

  lines.push('');
  lines.push(`## Retired (${diff.retired.length})`);
  if (diff.retired.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of diff.retired) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// People and Areas renderers (Migration 0006)
// ---------------------------------------------------------------------------

/**
 * Extract the slug from a person/area canonical_key.
 * `person:zhang-san` -> `zhang-san`; `area:frontend-build` -> `frontend-build`.
 * Returns null when the key does not match the expected prefix.
 */
export function personAreaSlug(canonicalKey: string): string | null {
  if (canonicalKey.startsWith('person:')) return canonicalKey.slice('person:'.length);
  if (canonicalKey.startsWith('area:')) return canonicalKey.slice('area:'.length);
  return null;
}

/**
 * Render `global/people/<slug>.md` — one file per person entry.
 *
 * The `content` field is produced by the consolidator's
 * `mergePersonAreaContent` and already contains the `## Summary` +
 * `## Details` body. This function adds the document title and the
 * auto-generated marker.
 */
export function renderPersonFile(entries: MemoryEntryRow[], slug: string): string {
  const active = entries.filter(
    (e) =>
      e.kind === 'person' &&
      e.status === 'active' &&
      e.canonical_key === `person:${slug}`
  );
  const title = slug.replace(/-/g, ' ');
  const header = [
    `# ${title}`,
    '',
    '<!-- Auto-generated by DUYA Memory v2 Phase 2. Do not edit. -->',
    '',
  ].join('\n');
  if (active.length === 0) {
    return `${header}_(no active entries)_`;
  }
  return `${header}${active[0].content}`;
}

/**
 * Render `global/areas/<slug>.md` — one file per area entry.
 * Same structure as `renderPersonFile`.
 */
export function renderAreaFile(entries: MemoryEntryRow[], slug: string): string {
  const active = entries.filter(
    (e) =>
      e.kind === 'area' &&
      e.status === 'active' &&
      e.canonical_key === `area:${slug}`
  );
  const title = slug.replace(/-/g, ' ');
  const header = [
    `# ${title}`,
    '',
    '<!-- Auto-generated by DUYA Memory v2 Phase 2. Do not edit. -->',
    '',
  ].join('\n');
  if (active.length === 0) {
    return `${header}_(no active entries)_`;
  }
  return `${header}${active[0].content}`;
}

/**
 * Render `global/people/index.md` — index of all person entries
 * (slug + canonical_key). Full content lives in per-person files.
 */
export function renderPeopleIndexFile(entries: MemoryEntryRow[]): string {
  const active = entries
    .filter((e) => e.kind === 'person' && e.status === 'active')
    .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  const updatedMs = maxUpdatedAt(active);
  const updatedIso = updatedMs > 0 ? new Date(updatedMs).toISOString() : 'never';

  const lines: string[] = [
    '# People Index',
    '',
    `Updated: ${updatedIso}`,
    '',
    'This file is automatically generated by DUYA Memory v2. Do not edit.',
    '',
  ];
  if (active.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of active) {
      const slug = personAreaSlug(entry.canonical_key) ?? entry.canonical_key;
      lines.push(`- [${slug}](./${slug}.md)`);
    }
  }
  return lines.join('\n');
}

/**
 * Render `global/areas/index.md` — index of all area entries.
 */
export function renderAreasIndexFile(entries: MemoryEntryRow[]): string {
  const active = entries
    .filter((e) => e.kind === 'area' && e.status === 'active')
    .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  const updatedMs = maxUpdatedAt(active);
  const updatedIso = updatedMs > 0 ? new Date(updatedMs).toISOString() : 'never';

  const lines: string[] = [
    '# Areas Index',
    '',
    `Updated: ${updatedIso}`,
    '',
    'This file is automatically generated by DUYA Memory v2. Do not edit.',
    '',
  ];
  if (active.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of active) {
      const slug = personAreaSlug(entry.canonical_key) ?? entry.canonical_key;
      lines.push(`- [${slug}](./${slug}.md)`);
    }
  }
  return lines.join('\n');
}

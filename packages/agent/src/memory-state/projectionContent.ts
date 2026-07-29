/**
 * Deterministic projection content rendering (Plan 303 Phase C, design v3
 * D11/D12).
 *
 * This module is the single source of truth for what the L1 file
 * projection SHOULD contain for a given `stage1_outputs` row set:
 *   - `rollout_summaries/<derived-filename>.md` per row
 *   - `raw_memories.md` merged across rows that carry `raw_memory`
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
    `project_id: ${yamlString(row.project_id)}`,
    `job_status: ${yamlString(row.job_status)}`,
    `content_outcome: ${row.content_outcome === null ? 'null' : yamlString(row.content_outcome)}`,
    `source_content_hash: ${yamlString(row.source_content_hash)}`,
    `schema_version: ${row.schema_version}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${row.rollout_summary ?? ''}`;
}

// ---------------------------------------------------------------------------
// raw_memories.md merged projection (Plan 304 Phase D, design v3 D7/D12)
// ---------------------------------------------------------------------------

/** Parsed shape of one `raw_memory` JSON evidence entry (loose: every
 * field optional so unparseable/partial items degrade gracefully). */
interface RawMemoryEvidence {
  source_type?: string;
  source_id?: string;
  verification?: string;
}

/** Parsed shape of one `raw_memory` JSON item. */
interface RawMemoryItem {
  canonical_key?: string;
  claim?: string;
  claim_type?: string;
  evidence?: RawMemoryEvidence[];
}

/** Section titles in their deterministic document order. */
const RAW_MEMORY_SECTIONS = ['Preference signals', 'Reusable knowledge', 'References'] as const;

/** claim_type → section title; unknown types are dropped. */
function sectionForClaimType(claimType: string | undefined): (typeof RAW_MEMORY_SECTIONS)[number] | null {
  switch (claimType) {
    case 'preference':
      return 'Preference signals';
    case 'fact':
    case 'procedure':
      return 'Reusable knowledge';
    case 'reference':
      return 'References';
    default:
      return null;
  }
}

function formatEvidence(evidence: RawMemoryEvidence[] | undefined): string {
  return (evidence ?? [])
    .map(
      (e) =>
        `${e.source_type ?? ''} ${e.source_id ?? ''}` +
        (e.verification ? ` [${e.verification}]` : '')
    )
    .join('; ');
}

/**
 * Parse `raw_memory` JSON into section-grouped items, preserving item
 * order within each group. Returns null when the JSON is missing,
 * unparseable, or has no `items` array (the caller still renders the
 * thread header and summary; only the sections are skipped).
 */
function parseRawMemoryGroups(rawMemory: string | null): Map<string, RawMemoryItem[]> | null {
  if (rawMemory == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMemory);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const groups = new Map<string, RawMemoryItem[]>();
  for (const item of items as RawMemoryItem[]) {
    if (typeof item !== 'object' || item === null) continue;
    const section = sectionForClaimType(item.claim_type);
    if (section === null) continue;
    const list = groups.get(section);
    if (list) {
      list.push(item);
    } else {
      groups.set(section, [item]);
    }
  }
  return groups;
}

/**
 * Merged projection of ALL Stage 1 outputs, including no-output
 * rollouts (Plan 304, design v3 D7: `raw_memories.md` is the Stage 1
 * output merge projection; a `succeeded_no_output` row still appears in
 * the thread listing so the file reflects that the rollout was
 * processed and will not be re-extracted).
 *
 * Rows are stably sorted by `thread_id` ASC, then `generated_at` ASC.
 * Returns null only when the table is empty (reconcile then treats an
 * existing file as stale and removes it). Rendering is pure: the same
 * rows always produce a byte-identical string.
 */
export function renderRawMemoriesFile(rows: Stage1OutputRow[]): string | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    if (a.thread_id < b.thread_id) return -1;
    if (a.thread_id > b.thread_id) return 1;
    return a.generated_at - b.generated_at;
  });

  const header = [
    '# Raw Memories',
    '',
    '<!-- Merged Stage 1 projection. Rebuilt from memory-state.db:stage1_outputs. Do not edit. -->',
  ].join('\n');

  const threadBlocks = sorted.map((row) => {
    const lines: string[] = [
      `## Thread ${row.thread_id}`,
      '',
      `- rollout_id: ${row.rollout_id}`,
      `- rollout_slug: ${row.rollout_slug}`,
      `- job_status: ${row.job_status}`,
      `- content_outcome: ${row.content_outcome ?? 'null'}`,
      `- generated_at: ${new Date(row.generated_at).toISOString()}`,
      `- source_content_hash: ${row.source_content_hash}`,
      '',
    ];
    if (row.job_status === 'succeeded_no_output') {
      lines.push('_No durable knowledge extracted from this rollout._');
    } else {
      lines.push(row.rollout_summary ?? '');
      const groups = parseRawMemoryGroups(row.raw_memory);
      if (groups !== null) {
        for (const section of RAW_MEMORY_SECTIONS) {
          const items = groups.get(section);
          if (!items || items.length === 0) continue;
          lines.push('');
          lines.push(`### ${section}`);
          for (const item of items) {
            lines.push(
              `- **${item.canonical_key ?? ''}** — ${item.claim ?? ''} _(evidence: ${formatEvidence(item.evidence)})_`
            );
          }
        }
      }
    }
    return lines.join('\n');
  });

  return [header, ...threadBlocks].join('\n\n');
}

// ---------------------------------------------------------------------------
// Phase 2 renderers (Plan 306 Phase B)
// ---------------------------------------------------------------------------

/**
 * Authoritative `memory_entries` row shape, mirroring migration 0005.
 */
export interface MemoryEntryRow {
  memory_id: string;
  scope: 'global' | 'project';
  project_id: string | null;
  kind: 'preference' | 'fact' | 'reference' | 'procedure';
  canonical_key: string;
  content: string;
  version: number;
  status: 'active' | 'superseded' | 'retired';
  created_at: number;
  updated_at: number;
}

/**
 * Authoritative `projects` row shape (migration 0001).
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
  scope: 'global' | 'project';
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
      return 'Reusable knowledge';
    case 'reference':
      return 'Failures and how to do differently';
    default:
      return null;
  }
}

function maxUpdatedAt(entries: MemoryEntryRow[]): number {
  if (entries.length === 0) return 0;
  return entries.reduce((max, e) => (e.updated_at > max ? e.updated_at : max), 0);
}

function renderCodexMemoryFile(entries: MemoryEntryRow[], title: string): string {
  const active = entries.filter((e) => e.status === 'active');
  const lines: string[] = [
    `# ${title}`,
    '',
    '<!-- Auto-generated by DUYA Memory v2 Phase 2. Do not edit. -->',
  ];

  for (const section of MEMORY_FILE_SECTIONS) {
    const sectionEntries = active
      .filter((e) => kindToMemorySection(e.kind) === section)
      .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));

    lines.push('');
    lines.push(`## ${section}`);

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

  return lines.join('\n');
}

/**
 * Render `global/MEMORY.md` — global-scope active entries in the Codex
 * MEMORY.md shape. Pure function; same input → byte-identical output.
 */
export function renderGlobalMemoryFile(entries: MemoryEntryRow[]): string {
  const global = entries.filter((e) => e.scope === 'global');
  return renderCodexMemoryFile(global, 'Memory (Global)');
}

/**
 * Render `projects/<id>/MEMORY.md` — project-scoped active entries in
 * the Codex MEMORY.md shape.
 */
export function renderProjectMemoryFile(entries: MemoryEntryRow[], projectId: string): string {
  const project = entries.filter(
    (e) => e.scope === 'project' && e.project_id === projectId
  );
  return renderCodexMemoryFile(project, `Memory (Project ${projectId})`);
}

/**
 * Render `global/summary.md` — Codex v1 header + What's in Memory
 * grouped by project (global first, then each project with entries).
 */
export function renderGlobalSummaryFile(
  entries: MemoryEntryRow[],
  projects: ProjectRow[]
): string {
  const active = entries.filter((e) => e.status === 'active');
  const updatedMs = maxUpdatedAt(active);
  const updatedIso = updatedMs > 0 ? new Date(updatedMs).toISOString() : 'never';

  const lines: string[] = [
    '# Memory Summary',
    '',
    `Updated: ${updatedIso}`,
    '',
    'This file is automatically generated by DUYA Memory v2. Do not edit.',
    '',
    "## What's in Memory",
  ];

  // Global section.
  const globalEntries = active
    .filter((e) => e.scope === 'global')
    .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  lines.push('');
  lines.push(`### Global (${globalEntries.length} entries)`);
  if (globalEntries.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of globalEntries) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
    }
  }

  // Per-project sections (only projects with entries).
  const projectIds = new Set(
    active
      .filter((e) => e.scope === 'project' && e.project_id !== null)
      .map((e) => e.project_id as string)
  );
  const sortedProjects = projects
    .filter((p) => projectIds.has(p.project_id))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));

  for (const project of sortedProjects) {
    const projectEntries = active
      .filter((e) => e.scope === 'project' && e.project_id === project.project_id)
      .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
    lines.push('');
    lines.push(`### Project ${project.project_id} (${projectEntries.length} entries)`);
    lines.push(`- canonical_root: ${project.canonical_root}`);
    for (const entry of projectEntries) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render `projects/<id>/summary.md` — Codex v1 header + project-scoped
 * entries.
 */
export function renderProjectSummaryFile(
  entries: MemoryEntryRow[],
  projectId: string
): string {
  const active = entries
    .filter(
      (e) =>
        e.status === 'active' &&
        e.scope === 'project' &&
        e.project_id === projectId
    )
    .sort((a, b) => a.canonical_key.localeCompare(b.canonical_key));
  const updatedMs = maxUpdatedAt(active);
  const updatedIso = updatedMs > 0 ? new Date(updatedMs).toISOString() : 'never';

  const lines: string[] = [
    '# Memory Summary',
    '',
    `Updated: ${updatedIso}`,
    '',
    `Project: ${projectId}`,
    '',
    'This file is automatically generated by DUYA Memory v2. Do not edit.',
    '',
    "## What's in Memory",
  ];

  if (active.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const entry of active) {
      lines.push(`- ${entry.canonical_key} [${entry.kind}]: ${entry.content}`);
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

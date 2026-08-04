/**
 * Deterministic projection content rendering (Plan 303 Phase C, design v3
 * D11/D12).
 *
 * This module is the single source of truth for what the L1 file
 * projection SHOULD contain for a given DB state:
 *   - `rollout_summaries/<derived-filename>.md` per Stage 1 row
 *
 * `reconcile.ts` compares disk against these renderings; the writer
 * aligns to this module so the write path and the reconcile path can
 * never drift apart. Rendering is pure (no I/O, no clock) so the same
 * input always produces byte-identical output.
 *
 * Phase 2 memory projections (`MEMORY.md`, `summary.md`,
 * `entities/<type>/index.md`) are no longer rendered here — they are
 * owned by `electron/memory/curation_projection.ts` (Plan 404) and
 * regenerated atomically by the curation publisher (Plan 406 Phase D).
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
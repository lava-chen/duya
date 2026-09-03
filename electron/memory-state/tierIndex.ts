/**
 * Bot memory tier index store (Plan 479 Phase 1, P1.1).
 *
 * Query index over the file-manifest memory tree. The FILES are the
 * source of truth; this table (`memory_tier_index`, migration 0010) is
 * rebuildable and exists so per-turn prompt rendering can run by-tier /
 * by-shard / merged-recall queries without filesystem scans.
 *
 * Write paths:
 *   - `rebuildTierIndexFromFiles` — full reconcile from the legacy user
 *     tier (`memory/items`, `memory/entities`, `memory/global`), used for
 *     backfill and drift repair. Dry-run capable.
 *   - `upsertTierEntry` — point write for the Plan 479 Phase 3 writer
 *     (`update_state` via the curation manifest pipeline). Own-tier
 *     entries live under `agents/<agentId>/memory/` (Plan 485
 *     reservation, dir-based option chosen by the P1.0 decision).
 *
 * Row identity: `entry_id` = sha256(`tier|agent_profile_id|project_id|
 * dedupe_key`) — deterministic, stable across file moves, and the
 * upsert conflict target. `file_path` is duya-root-relative with
 * forward slashes and uniquely identifies the backing file.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getLogger, LogComponent } from '../logging/logger';
import { parseCanonicalFile } from '../../packages/agent/src/memory-state/canonical_file';
import {
  mergeTierRecall,
  type MemoryTier,
  type TierEntryKind,
  type MergedTierRecall,
} from './tierConflicts';

export type { MemoryTier, TierEntryKind, MergedTierRecall };

export interface TierIndexRow {
  entry_id: string;
  tier: MemoryTier;
  agent_profile_id: string;
  project_id: string;
  kind: TierEntryKind;
  dedupe_key: string;
  file_path: string;
  content_hash: string;
  created_at: number;
  updated_at: number;
}

export interface UpsertTierEntryInput {
  tier: MemoryTier;
  /** Own-tier owner / shared-layer writer. Required for tier='agent'. */
  agentProfileId?: string;
  /** Project scope id. Required for tier='project'. */
  projectId?: string;
  kind: TierEntryKind;
  /** Normalized (trim + lowercase) inside this function. */
  dedupeKey: string;
  /** Duya-root-relative, forward slashes. */
  filePath: string;
  contentHash: string;
  createdAt?: number;
  updatedAt: number;
}

export interface TierQueryFilter {
  tier: MemoryTier;
  agentProfileId?: string;
  projectId?: string;
  /** Project-tier membership list (the bot's joined projects). */
  projectIds?: string[];
  kind?: TierEntryKind;
}

export interface TierShardSummary {
  tier: MemoryTier;
  agentProfileId: string;
  projectId: string;
  entryCount: number;
  lastUpdatedAt: number;
}

export interface TierRebuildReport {
  dryRun: boolean;
  scannedFiles: number;
  parsed: number;
  skipped: number;
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: Array<{ filePath: string; error: string }>;
}

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

const TIERS: readonly MemoryTier[] = ['agent', 'user', 'project'];
const KINDS: readonly TierEntryKind[] = ['profile', 'log', 'note'];

/**
 * Legacy user-tier roots scanned by the backfill/reconcile pass,
 * relative to the duya root. Own-tier (`agents/<id>/memory/`) and
 * project-tier write-side indexing arrive with the Phase 3 writer,
 * which calls `upsertTierEntry` directly.
 */
const REBUILD_SCAN_ROOTS: readonly string[] = ['memory/items', 'memory/entities', 'memory/global'];

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function normalizeDedupeKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function computeTierEntryId(
  tier: MemoryTier,
  agentProfileId: string,
  projectId: string,
  dedupeKey: string
): string {
  return sha256(`${tier}|${agentProfileId}|${projectId}|${dedupeKey}`);
}

/**
 * Reject paths that would escape the duya root or poison later joins:
 * absolute paths, drive letters, backslashes, traversal segments.
 */
function assertSafeRelPath(filePath: string): void {
  if (filePath.length === 0) throw new Error('tier-index: file_path must not be empty');
  if (filePath.includes('\\')) throw new Error(`tier-index: file_path must use forward slashes: ${filePath}`);
  if (path.isAbsolute(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    throw new Error(`tier-index: file_path must be relative to the duya root: ${filePath}`);
  }
  if (filePath.split('/').includes('..')) {
    throw new Error(`tier-index: file_path must not traverse up: ${filePath}`);
  }
}

function validateInput(input: UpsertTierEntryInput): void {
  if (!TIERS.includes(input.tier)) throw new Error(`tier-index: unknown tier ${input.tier}`);
  if (!KINDS.includes(input.kind)) throw new Error(`tier-index: unknown kind ${input.kind}`);
  if (input.tier === 'agent' && !(input.agentProfileId ?? '').trim()) {
    throw new Error('tier-index: tier=agent requires agentProfileId');
  }
  if (input.tier === 'project' && !(input.projectId ?? '').trim()) {
    throw new Error('tier-index: tier=project requires projectId');
  }
  if (!input.dedupeKey.trim()) throw new Error('tier-index: dedupeKey must not be empty');
  assertSafeRelPath(input.filePath);
}

/**
 * Point upsert with newest-wins semantics (P1.2 alignment): an existing
 * row is updated only when the incoming `updatedAt` is strictly newer,
 * or equal with a changed content hash (same-millisecond rewrite).
 * `created_at` is preserved from first insert.
 */
export function upsertTierEntry(db: Database, input: UpsertTierEntryInput): UpsertOutcome {
  validateInput(input);
  const dedupeKey = normalizeDedupeKey(input.dedupeKey);
  const agentProfileId = (input.agentProfileId ?? '').trim();
  const projectId = (input.projectId ?? '').trim();
  const entryId = computeTierEntryId(input.tier, agentProfileId, projectId, dedupeKey);

  const existing = db
    .prepare('SELECT entry_id, created_at, updated_at, content_hash FROM memory_tier_index WHERE entry_id = ?')
    .get(entryId) as Pick<TierIndexRow, 'entry_id' | 'created_at' | 'updated_at' | 'content_hash'> | undefined;

  if (!existing) {
    try {
      db.prepare(
        `INSERT INTO memory_tier_index
           (entry_id, tier, agent_profile_id, project_id, kind, dedupe_key, file_path, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        input.tier,
        agentProfileId,
        projectId,
        input.kind,
        dedupeKey,
        input.filePath,
        input.contentHash,
        input.createdAt ?? input.updatedAt,
        input.updatedAt
      );
      return 'inserted';
    } catch (err) {
      throw explainConstraintError(err, input, dedupeKey);
    }
  }

  const incomingNewer =
    input.updatedAt > existing.updated_at ||
    (input.updatedAt === existing.updated_at && input.contentHash !== existing.content_hash);
  if (!incomingNewer) return 'unchanged';

  try {
    db.prepare(
      `UPDATE memory_tier_index
         SET kind = ?, file_path = ?, content_hash = ?, updated_at = ?
       WHERE entry_id = ?`
    ).run(input.kind, input.filePath, input.contentHash, input.updatedAt, entryId);
    return 'updated';
  } catch (err) {
    throw explainConstraintError(err, input, dedupeKey);
  }
}

function explainConstraintError(err: unknown, input: UpsertTierEntryInput, dedupeKey: string): Error {
  const code = (err as { code?: string }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
    return new Error(
      `tier-index: constraint violated for ${input.tier}/${input.filePath} ` +
      `(dedupe_key '${dedupeKey}' likely collides within the same shard after normalization): ` +
      `${(err as Error).message}`
    );
  }
  return err as Error;
}

function rowToTierIndexRow(row: Record<string, unknown>): TierIndexRow {
  return row as unknown as TierIndexRow;
}

export function listTierEntries(db: Database, filter: TierQueryFilter): TierIndexRow[] {
  const where: string[] = ['tier = ?'];
  const params: unknown[] = [filter.tier];
  if (filter.agentProfileId !== undefined) {
    where.push('agent_profile_id = ?');
    params.push(filter.agentProfileId);
  }
  if (filter.projectId !== undefined) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.projectIds !== undefined) {
    if (filter.projectIds.length === 0) return [];
    where.push(`project_id IN (${filter.projectIds.map(() => '?').join(', ')})`);
    params.push(...filter.projectIds);
  }
  if (filter.kind !== undefined) {
    where.push('kind = ?');
    params.push(filter.kind);
  }
  const rows = db
    .prepare(
      `SELECT * FROM memory_tier_index
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, dedupe_key ASC`
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToTierIndexRow);
}

export function listTierShards(db: Database, tier: MemoryTier): TierShardSummary[] {
  return db
    .prepare(
      `SELECT tier,
              agent_profile_id AS agentProfileId,
              project_id       AS projectId,
              COUNT(*)         AS entryCount,
              MAX(updated_at)  AS lastUpdatedAt
       FROM memory_tier_index
       WHERE tier = ?
       GROUP BY agent_profile_id, project_id
       ORDER BY lastUpdatedAt DESC`
    )
    .all(tier) as TierShardSummary[];
}

export function getTierEntryByPath(db: Database, filePath: string): TierIndexRow | null {
  const row = db
    .prepare('SELECT * FROM memory_tier_index WHERE file_path = ?')
    .get(filePath) as Record<string, unknown> | undefined;
  return row ? rowToTierIndexRow(row) : null;
}

export function removeTierEntryByPath(db: Database, filePath: string): boolean {
  const result = db.prepare('DELETE FROM memory_tier_index WHERE file_path = ?').run(filePath);
  return result.changes > 0;
}

/**
 * Merged recall for prompt rendering (plan 479 §3.2): own > project >
 * user, cross-shard dedupe with earliest-via attribution per tier.
 * `projectIds` is the bot's joined-project membership (Phase 3 state);
 * absent or empty means no project tier participation.
 */
export function mergedTierRecall(
  db: Database,
  opts: { agentProfileId: string; projectIds?: string[] }
): MergedTierRecall<TierIndexRow> {
  const own = listTierEntries(db, { tier: 'agent', agentProfileId: opts.agentProfileId });
  const project = opts.projectIds?.length
    ? listTierEntries(db, { tier: 'project', projectIds: opts.projectIds })
    : [];
  const user = listTierEntries(db, { tier: 'user' });
  return mergeTierRecall({ own, project, user }, {
    keyOf: (row) => row.dedupe_key,
    timeOf: (row) => row.updated_at,
    bornOf: (row) => row.created_at,
    shardOf: (row) =>
      row.tier === 'agent'
        ? `agent:${row.agent_profile_id}`
        : row.tier === 'project'
          ? `project:${row.project_id}/${row.agent_profile_id}`
          : `user:${row.agent_profile_id}`,
  });
}

function walkMdFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkMdFiles(full, out);
    } else if (stat.isFile() && entry.endsWith('.md')) {
      out.push(full);
    }
  }
}

function toDuyaRelPath(absolutePath: string, duyaRoot: string): string {
  return path.relative(duyaRoot, absolutePath).split(path.sep).join('/');
}

/**
 * Full reconcile of the tier index against the legacy user-tier file
 * tree (backfill + drift repair). Plan 479 §3.1 backfill rule: files
 * with a project_id → project tier, otherwise user tier; kind='note'
 * for all legacy records (profile/log only exist from Phase 3 on).
 * Retired files (status != 'active') are skipped — they are history,
 * not recallable memory.
 *
 * Dry-run computes the report without writing. Removals are scoped to
 * rows under REBUILD_SCAN_ROOTS so agent/project rows written by the
 * Phase 3 writer are never touched by this pass.
 */
export function rebuildTierIndexFromFiles(
  db: Database,
  duyaRoot: string,
  opts: { dryRun?: boolean; now?: number } = {}
): TierRebuildReport {
  const logger = getLogger();
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const report: TierRebuildReport = {
    dryRun,
    scannedFiles: 0,
    parsed: 0,
    skipped: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    errors: [],
  };

  const files: string[] = [];
  for (const root of REBUILD_SCAN_ROOTS) {
    const absRoot = path.join(duyaRoot, root);
    if (!fs.existsSync(absRoot)) continue;
    walkMdFiles(absRoot, files);
  }
  report.scannedFiles = files.length;

  // Pure pass: parse, hash, and timestamp every candidate file up front.
  // No DB writes here — dry-run gets real parsed/skipped counts for free.
  interface PlannedEntry {
    tier: MemoryTier;
    projectId: string;
    dedupeKey: string;
    filePath: string;
    contentHash: string;
    updatedAt: number;
  }
  const planned: PlannedEntry[] = [];
  for (const file of files) {
    const relPath = toDuyaRelPath(file, duyaRoot);
    let parsed: ReturnType<typeof parseCanonicalFile>;
    try {
      parsed = parseCanonicalFile(file);
    } catch (err) {
      report.errors.push({ filePath: relPath, error: (err as Error).message });
      continue;
    }
    if (!parsed) {
      report.skipped += 1;
      continue;
    }
    if (parsed.status !== 'active') {
      report.skipped += 1;
      continue;
    }

    let updatedAt = Date.parse(parsed.updated_at);
    if (Number.isNaN(updatedAt)) {
      try {
        updatedAt = Math.trunc(fs.statSync(file).mtimeMs);
      } catch {
        updatedAt = now;
      }
    }
    let contentHash: string;
    try {
      contentHash = sha256(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      report.errors.push({ filePath: relPath, error: (err as Error).message });
      continue;
    }

    report.parsed += 1;
    planned.push({
      tier: parsed.project_id ? 'project' : 'user',
      projectId: parsed.project_id ?? '',
      dedupeKey: normalizeDedupeKey(parsed.canonical_key),
      filePath: relPath,
      contentHash,
      updatedAt,
    });
  }

  if (!dryRun) {
    const syncPass = db.transaction(() => {
      for (const entry of planned) {
        let outcome: UpsertOutcome;
        try {
          outcome = upsertTierEntry(db, {
            tier: entry.tier,
            agentProfileId: '',
            projectId: entry.projectId,
            kind: 'note',
            dedupeKey: entry.dedupeKey,
            filePath: entry.filePath,
            contentHash: entry.contentHash,
            updatedAt: entry.updatedAt,
          });
        } catch (err) {
          report.errors.push({ filePath: entry.filePath, error: (err as Error).message });
          report.parsed -= 1;
          continue;
        }
        if (outcome === 'inserted') report.inserted += 1;
        else if (outcome === 'updated') report.updated += 1;
        else report.unchanged += 1;
      }

      // Removal pass: drop rows whose backing file vanished (full-sync
      // semantics), scoped to the scanned roots so rows written by the
      // Phase 3 writer (agents/, projects/) are never touched.
      const likeClauses = REBUILD_SCAN_ROOTS.map(() => "file_path LIKE ?").join(' OR ');
      const likeParams = REBUILD_SCAN_ROOTS.map((r) => `${r}/%`);
      const scoped = db
        .prepare(`SELECT file_path FROM memory_tier_index WHERE ${likeClauses}`)
        .all(...likeParams) as Array<{ file_path: string }>;
      const removeStmt = db.prepare('DELETE FROM memory_tier_index WHERE file_path = ?');
      for (const { file_path } of scoped) {
        const abs = path.join(duyaRoot, ...file_path.split('/'));
        if (!fs.existsSync(abs)) {
          report.removed += removeStmt.run(file_path).changes;
        }
      }
    });
    syncPass();
  }

  logger.info(
    'memory tier index rebuild complete',
    {
      dryRun,
      scannedFiles: report.scannedFiles,
      parsed: report.parsed,
      skipped: report.skipped,
      inserted: report.inserted,
      updated: report.updated,
      unchanged: report.unchanged,
      removed: report.removed,
      errors: report.errors.length,
    },
    LogComponent.DB
  );

  return report;
}

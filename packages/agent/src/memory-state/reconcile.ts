/**
 * Startup reconciliation (Plan 303 Phase C, design v3 D12 + Plan 306 Phase B).
 *
 * Rebuilds the L1 file projection from the DB (the source of truth):
 *   - `rollout_summaries/*.md`       — one file per `stage1_outputs` row
 *   - `raw_memories.md`              — merged projection of rows with raw_memory
 *   - `global/MEMORY.md`             — Phase 2 canonical global entries
 *   - `projects/<id>/MEMORY.md`      — Phase 2 canonical per-project entries
 *   - `global/summary.md`            — Phase 2 summary across all scopes
 *   - `projects/<id>/summary.md`     — Phase 2 per-project summary
 *   - `phase2_workspace_diff.md`     — last Phase 2 run diff (transient)
 *
 * The reconciler itself NEVER writes or deletes files; every divergence
 * becomes a `projection_outbox` row (via `enqueueProjectionOutbox`), so
 * the outbox stays the only mechanism that mutates the projection.
 * Files whose names do not match the projection filename grammar are
 * user-owned and are never touched.
 *
 * Phase 2 reconciliation is guarded by a `memory_entries` table-existence
 * check so it degrades to a no-op when migration 0005 has not been
 * applied (e.g. during partial rollouts or fresh installs).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { computeContentHash, enqueueProjectionOutbox } from './outbox.js';
import {
  deriveRolloutSummaryFilename,
  renderGlobalMemoryFile,
  renderGlobalSummaryFile,
  renderPhase2WorkspaceDiff,
  renderProjectMemoryFile,
  renderProjectSummaryFile,
  renderRawMemoriesFile,
  renderRolloutSummaryFile,
  type MemoryEntryRow,
  type Phase2Diff,
  type Phase2DiffEntry,
  type ProjectRow,
  type Stage1OutputRow,
} from './projectionContent.js';

export interface ReconcileReport {
  /** Paths for which a `write` was planned (missing or drifted files). */
  written: string[];
  /** Paths for which a `delete` was planned (orphan / stale files). */
  removed: string[];
  /** Subset of `written` where a file existed but content drifted. */
  mismatched: string[];
  durationMs: number;
}

export interface ReconcileOptions {
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
  /** When true, only report — do not enqueue any outbox rows. */
  dryRun?: boolean;
  now?: number;
}

interface PlannedAction {
  targetPath: string;
  operation: 'write' | 'delete';
  content: string | null;
}

/** D11 shape: `<YYYY-MM-DD>T<HH-MM-SS>-<shortid>-<slug>.md`. */
const D11_FILENAME_RE =
  /^(?<iso>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(?<shortid>[0-9a-f]{4,16})-(?<slug>[a-z0-9-]{3,80})\.md$/;
/** Legacy compat shape: `<YYYYMMDD>T<HHMMSS>.<ms>Z-<shortid>-<slug>.md`. */
const COMPAT_FILENAME_RE =
  /^(?<iso>\d{8}T\d{6}\.\d{3}Z)-(?<shortid>[0-9a-f]{4,16})-(?<slug>[a-z0-9-]{3,80})\.md$/;

export function reconcileProjections(db: Database, opts: ReconcileOptions = {}): ReconcileReport {
  const startedAt = opts.now ?? Date.now();
  const rootDir = opts.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
  const dryRun = opts.dryRun ?? false;

  const rows = db.prepare('SELECT * FROM stage1_outputs').all() as Stage1OutputRow[];
  const summariesDir = path.join(rootDir, 'rollout_summaries');

  const written: string[] = [];
  const removed: string[] = [];
  const mismatched: string[] = [];
  const planned: PlannedAction[] = [];

  // 1-2. Every DB row must have an on-disk file with matching content.
  for (const row of rows) {
    const expectedPath = path.join(summariesDir, deriveRolloutSummaryFilename(row));
    let needsWrite = false;
    if (!fs.existsSync(expectedPath)) {
      needsWrite = true;
    } else {
      const diskHash = computeContentHash(fs.readFileSync(expectedPath, 'utf8'));
      const expectedHash =
        row.content_hash_at_write ?? computeContentHash(renderRolloutSummaryFile(row));
      if (diskHash !== expectedHash) {
        needsWrite = true;
        mismatched.push(expectedPath);
      }
    }
    if (needsWrite) {
      planned.push({
        targetPath: expectedPath,
        operation: 'write',
        content: renderRolloutSummaryFile(row),
      });
      written.push(expectedPath);
    }
  }

  // 3. Disk files that do not map to any DB row are orphans (crashed
  //    drainers, deleted rollouts). Files outside the filename grammar
  //    are user-owned and ignored.
  if (fs.existsSync(summariesDir)) {
    for (const entry of fs.readdirSync(summariesDir)) {
      if (!entry.endsWith('.md')) continue;
      const match = D11_FILENAME_RE.exec(entry) ?? COMPAT_FILENAME_RE.exec(entry);
      const shortid = match?.groups?.shortid;
      if (!shortid) continue;
      const candidates = rows.filter((r) =>
        r.rollout_id.replace(/-/g, '').toLowerCase().startsWith(shortid)
      );
      let matched: Stage1OutputRow | undefined;
      if (candidates.length === 1) {
        matched = candidates[0];
      } else if (candidates.length > 1) {
        // Disambiguate by exact derived-filename match; no exact match
        // means the file cannot be attributed and is an orphan.
        matched = candidates.find((c) => deriveRolloutSummaryFilename(c) === entry);
      }
      if (!matched) {
        const targetPath = path.join(summariesDir, entry);
        planned.push({ targetPath, operation: 'delete', content: null });
        removed.push(targetPath);
      }
      // A matched file already handled by step 2 (planned rewrite) is
      // not enqueued again here.
    }
  }

  // 4. raw_memories.md merged projection (Plan 304: ALL rows feed the
  //    merge, including no-output rollouts; the render returns null
  //    only when the table is empty).
  const rawPath = path.join(rootDir, 'raw_memories.md');
  const rawExpected = renderRawMemoriesFile(rows);
  if (rawExpected !== null) {
    const diskMatches =
      fs.existsSync(rawPath) &&
      computeContentHash(fs.readFileSync(rawPath, 'utf8')) === computeContentHash(rawExpected);
    if (!diskMatches) {
      planned.push({ targetPath: rawPath, operation: 'write', content: rawExpected });
      written.push(rawPath);
    }
  } else if (fs.existsSync(rawPath)) {
    planned.push({ targetPath: rawPath, operation: 'delete', content: null });
    removed.push(rawPath);
  }

  // 5. Phase 2 projections (Plan 306 Phase B): global/MEMORY.md,
  //    projects/<id>/MEMORY.md, global/summary.md,
  //    projects/<id>/summary.md, phase2_workspace_diff.md.
  //    Guarded by table-existence so a DB without migration 0005
  //    (e.g. fresh install mid-rollout) skips Phase 2 cleanly.
  if (tableExists(db, 'memory_entries')) {
    reconcilePhase2Projections(db, rootDir, planned, written, removed);
  }

  // 6. Apply via the outbox (the only projection writer, D12).
  if (!dryRun) {
    for (const action of planned) {
      enqueueProjectionOutbox(db, {
        targetPath: action.targetPath,
        operation: action.operation,
        content: action.content,
        now: opts.now,
      });
    }
  }

  const finishedAt = opts.now ?? Date.now();
  return { written, removed, mismatched, durationMs: finishedAt - startedAt };
}

// ---------------------------------------------------------------------------
// Phase 2 reconciliation helpers (Plan 306 Phase B)
// ---------------------------------------------------------------------------

/** True when `tableName` exists in the DB (sqlite_master). */
function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(tableName);
  return row !== undefined;
}

/**
 * Reconcile the 5 Phase 2 projection files. Mutates the `planned`,
 * `written`, and `removed` arrays in place. Each file is compared
 * against the rendered-from-DB content; mismatches become `write`
 * actions and orphans become `delete` actions.
 *
 * `phase2_workspace_diff.md` is rebuilt from the last succeeded
 * `phase2_runs` row's `output_diff_summary` JSON. When no run exists
 * yet, an existing file is treated as an orphan and removed.
 */
function reconcilePhase2Projections(
  db: Database,
  rootDir: string,
  planned: PlannedAction[],
  written: string[],
  removed: string[]
): void {
  const entries = db
    .prepare('SELECT * FROM memory_entries')
    .all() as MemoryEntryRow[];
  const projects = db
    .prepare('SELECT * FROM projects')
    .all() as ProjectRow[];

  // Collect the set of project IDs that own at least one entry —
  // used both for per-project file writes and for orphan detection.
  const projectIdsWithEntries = new Set(
    entries
      .filter((e) => e.scope === 'project' && e.project_id !== null)
      .map((e) => e.project_id as string)
  );

  // --- global/MEMORY.md ---
  planFileWrite(
    path.join(rootDir, 'global', 'MEMORY.md'),
    renderGlobalMemoryFile(entries),
    planned,
    written
  );

  // --- projects/<id>/MEMORY.md (only for projects with entries) ---
  for (const pid of projectIdsWithEntries) {
    planFileWrite(
      path.join(rootDir, 'projects', pid, 'MEMORY.md'),
      renderProjectMemoryFile(entries, pid),
      planned,
      written
    );
  }

  // --- global/summary.md ---
  planFileWrite(
    path.join(rootDir, 'global', 'summary.md'),
    renderGlobalSummaryFile(entries, projects),
    planned,
    written
  );

  // --- projects/<id>/summary.md (only for projects with entries) ---
  for (const pid of projectIdsWithEntries) {
    planFileWrite(
      path.join(rootDir, 'projects', pid, 'summary.md'),
      renderProjectSummaryFile(entries, pid),
      planned,
      written
    );
  }

  // --- orphan project MEMORY.md / summary.md (project no longer has entries) ---
  const projectsDir = path.join(rootDir, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const entry of fs.readdirSync(projectsDir)) {
      const projectDir = path.join(projectsDir, entry);
      if (!fs.statSync(projectDir).isDirectory()) continue;
      // Only scan UUID-shaped directories to avoid touching user content.
      if (!/^[0-9a-fA-F-]{36}$/.test(entry)) continue;
      if (projectIdsWithEntries.has(entry)) continue;

      for (const filename of ['MEMORY.md', 'summary.md']) {
        const filePath = path.join(projectDir, filename);
        if (fs.existsSync(filePath)) {
          planned.push({ targetPath: filePath, operation: 'delete', content: null });
          removed.push(filePath);
        }
      }
    }
  }

  // --- phase2_workspace_diff.md (rebuilt from last succeeded run) ---
  const lastRun = db
    .prepare(
      `SELECT id, input_set_hash, output_diff_summary, finished_at
       FROM phase2_runs
       WHERE status = 'succeeded'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get() as
    | {
        id: number;
        input_set_hash: string;
        output_diff_summary: string | null;
        finished_at: number | null;
      }
    | undefined;

  const diffPath = path.join(rootDir, 'phase2_workspace_diff.md');
  if (lastRun && lastRun.output_diff_summary) {
    let diff: Phase2Diff;
    try {
      const parsed = JSON.parse(lastRun.output_diff_summary) as Partial<Phase2Diff> & {
        added?: Phase2DiffEntry[];
        superseded?: Phase2DiffEntry[];
        retired?: Phase2DiffEntry[];
      };
      diff = {
        added: parsed.added ?? [],
        superseded: parsed.superseded ?? [],
        retired: parsed.retired ?? [],
        runId: lastRun.id,
        inputHash: lastRun.input_set_hash,
        timestamp: lastRun.finished_at ?? Date.now(),
      };
    } catch {
      // Malformed JSON — treat as a fresh empty diff so the file at
      // least reflects the run metadata.
      diff = {
        added: [],
        superseded: [],
        retired: [],
        runId: lastRun.id,
        inputHash: lastRun.input_set_hash,
        timestamp: lastRun.finished_at ?? Date.now(),
      };
    }
    planFileWrite(diffPath, renderPhase2WorkspaceDiff(diff), planned, written);
  } else if (fs.existsSync(diffPath)) {
    // No succeeded run yet — remove the stale diff file.
    planned.push({ targetPath: diffPath, operation: 'delete', content: null });
    removed.push(diffPath);
  }
}

/**
 * Compare a rendered file against disk and enqueue a `write` action
 * when missing or drifted. Mutates `planned` and `written` in place.
 */
function planFileWrite(
  targetPath: string,
  expectedContent: string,
  planned: PlannedAction[],
  written: string[]
): void {
  let needsWrite = false;
  if (!fs.existsSync(targetPath)) {
    needsWrite = true;
  } else {
    const diskHash = computeContentHash(fs.readFileSync(targetPath, 'utf8'));
    const expectedHash = computeContentHash(expectedContent);
    if (diskHash !== expectedHash) {
      needsWrite = true;
    }
  }
  if (needsWrite) {
    planned.push({ targetPath, operation: 'write', content: expectedContent });
    written.push(targetPath);
  }
}

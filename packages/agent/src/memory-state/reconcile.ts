/**
 * Startup reconciliation (Plan 303 Phase C + Plan 406 Phase D downgrade).
 *
 * After Phase D, this module reconciles ONLY the Stage 1 file projection:
 *   - `rollout_summaries/*.md` — one file per `stage1_outputs` row
 *
 * The Phase 2 memory projections (`MEMORY.md`, `summary.md`,
 * `entities/<type>/index.md`) are now owned by `curation_projection.ts`
 * (Plan 404) and regenerated atomically by the curation publisher. They
 * are NOT touched here.
 *
 * The reconciler itself NEVER writes or deletes files; every divergence
 * becomes a `projection_outbox` row (via `enqueueProjectionOutbox`), so
 * the outbox stays the only mechanism that mutates the projection.
 * Files whose names do not match the projection filename grammar are
 * user-owned and are never touched.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { computeContentHash, enqueueProjectionOutbox } from './outbox.js';
import {
  deriveRolloutSummaryFilename,
  renderRolloutSummaryFile,
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

/**
 * True when the row has a non-empty summary body worth projecting to disk.
 * `succeeded_no_output` rows have `rollout_summary = NULL` and produce
 * empty files — skip them so the folder only contains real evidence.
 */
function hasSummaryContent(row: Stage1OutputRow): boolean {
  return row.rollout_summary !== null && row.rollout_summary.trim().length > 0;
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

  // 1-2. Every DB row WITH content must have an on-disk file with matching
  //       content. Rows with no summary (succeeded_no_output) have nothing
  //       to project — skip them so we don't litter the folder with empty
  //       files. Existing files mapping to such rows are cleaned up in step 3.
  for (const row of rows) {
    if (!hasSummaryContent(row)) {
      continue;
    }
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
      // No match OR match is a no-content row (succeeded_no_output) that
      // should not have a file — either way the file is an orphan.
      if (!matched || !hasSummaryContent(matched)) {
        const targetPath = path.join(summariesDir, entry);
        planned.push({ targetPath, operation: 'delete', content: null });
        removed.push(targetPath);
      }
      // A matched file already handled by step 2 (planned rewrite) is
      // not enqueued again here.
    }
  }

  // 4. raw_memories.md duplicated the DB and rollout evidence layer. It is
  //    retired so broad rg searches do not return the same claim repeatedly.
  const rawPath = path.join(rootDir, 'raw_memories.md');
  if (fs.existsSync(rawPath)) {
    planned.push({ targetPath: rawPath, operation: 'delete', content: null });
    removed.push(rawPath);
  }

  // 5. Apply via the outbox (the only projection writer, D12).
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
/**
 * Phase 2 consolidator (Plan 306 Phase B).
 *
 * Promotes Stage 1 extraction outputs into canonical memory entries:
 *   - acquires a global lock (phase2_runs row)
 *   - computes an input-set hash for CAS-skip idempotency
 *   - parses raw_memory JSON from eligible stage1_outputs
 *   - re-enforces the D8 guard (external-only evidence cannot form
 *     preference/procedure)
 *   - digests ad-hoc `.md` files from `extensions/ad_hoc/`
 *   - groups items by (scope, project_id, canonical_key), picks a
 *     winner per group (highest evidence.verification, tiebreak by
 *     generated_at DESC; ad-hoc entries always win)
 *   - UPSERTs memory_entries + inserts memory_evidence rows
 *   - renders + enqueues 5 projection files via the outbox
 *   - releases the lock
 *
 * All DB writes in steps 6-10 run inside ONE `BEGIN IMMEDIATE`
 * transaction; a crash rolls back and the catch block releases the
 * lock as 'failed'.
 *
 * Shadow mode: the only production caller is `consolidatorTick` in
 * `electron/memory/memory-worker.ts`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { enqueueProjectionOutbox } from './outbox.js';
import {
  renderGlobalMemoryFile,
  renderProjectMemoryFile,
  renderGlobalSummaryFile,
  renderProjectSummaryFile,
  renderPhase2WorkspaceDiff,
  type MemoryEntryRow,
  type ProjectRow,
  type Phase2Diff,
  type Phase2DiffEntry,
} from './projectionContent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lock timeout: 5 minutes. */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

const AD_HOC_DIR_NAME = 'extensions/ad_hoc';
const DIGESTED_SUBDIR = '.digested';

/**
 * D8 guard: external source types cannot form preference/procedure.
 * Duplicated from `extractor.ts` (not exported there); keep in sync.
 */
const EXTERNAL_SOURCE_TYPES = new Set(['browser_page', 'mcp_response']);

/** Verification level ranking (higher = stronger). */
const VERIFICATION_RANK: Record<string, number> = {
  none: 1,
  inferred: 2,
  observed: 3,
  verified_code: 4,
  verified_user: 5,
};

/** Ad-hoc entries always win (rank above any evidence verification). */
const AD_HOC_RANK = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConsolidatorInput {
  db: Database;
  now?: number;
  lockTimeoutMs?: number;
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
}

export interface ConsolidatorResult {
  skipped: boolean;
  runId?: number;
  added: number;
  merged: number;
  superseded: number;
  retired: number;
  adHocDigested: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedEvidence {
  source_type: string;
  source_id: string;
  verification?: string;
}

interface ParsedItem {
  rolloutId: string;
  itemIndex: number;
  claim: string;
  claimType: string;
  canonicalKey: string;
  evidence: ParsedEvidence[];
  generatedAt: number;
  projectId: string;
  isAdHoc: boolean;
  content: string;
}

interface ItemGroup {
  scope: 'global' | 'project';
  projectId: string | null;
  canonicalKey: string;
  items: ParsedItem[];
}

interface AdHocFile {
  filename: string;
  filePath: string;
  content: string;
  scope: 'global' | 'project';
  projectId: string | null;
  canonicalKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopeForProject(projectId: string): 'global' | 'project' {
  return projectId === 'global' ? 'global' : 'project';
}

function maxVerificationRank(evidence: ParsedEvidence[]): number {
  let max = 0;
  for (const ev of evidence) {
    const rank = VERIFICATION_RANK[ev.verification ?? 'none'] ?? 0;
    if (rank > max) max = rank;
  }
  return max;
}

function itemRank(item: ParsedItem): number {
  if (item.isAdHoc) return AD_HOC_RANK;
  return maxVerificationRank(item.evidence);
}

function pickWinner(items: ParsedItem[]): ParsedItem {
  return items.reduce((best, item) => {
    const itemScore = itemRank(item);
    const bestScore = itemRank(best);
    if (itemScore > bestScore) return item;
    if (itemScore < bestScore) return best;
    return item.generatedAt > best.generatedAt ? item : best;
  });
}

function hasExternalSourceOnly(item: ParsedItem): boolean {
  if (item.evidence.length === 0) return false;
  return item.evidence.every((ev) => EXTERNAL_SOURCE_TYPES.has(ev.source_type));
}

/** D8: external-only evidence cannot form preference or procedure. */
function d8AllowsKind(item: ParsedItem): boolean {
  if (
    hasExternalSourceOnly(item) &&
    (item.claimType === 'preference' || item.claimType === 'procedure')
  ) {
    return false;
  }
  return true;
}

function computeInputSetHash(db: Database): string {
  const rows = db
    .prepare(
      `SELECT rollout_id, source_content_hash
       FROM stage1_outputs
       WHERE job_status = 'succeeded'
         AND content_outcome IN ('success', 'partial')
       ORDER BY rollout_id ASC`
    )
    .all() as Array<{ rollout_id: string; source_content_hash: string }>;

  const payload = rows
    .map((r) => `${r.rollout_id}:${r.source_content_hash}`)
    .join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

interface LockAcquired {
  skipped: false;
  runId: number;
  token: string;
}

interface LockSkipped {
  skipped: true;
}

function acquireLock(
  db: Database,
  now: number,
  lockTimeoutMs: number
): LockAcquired | LockSkipped {
  const token = crypto.randomUUID();

  const txn = db.transaction((): LockAcquired | LockSkipped => {
    const running = db
      .prepare('SELECT id, started_at, lock_holder FROM phase2_runs WHERE status = ?')
      .get('running') as
      | { id: number; started_at: number; lock_holder: string | null }
      | undefined;

    if (running) {
      if (running.started_at > now - lockTimeoutMs) {
        // Fresh lock held by another run — skip.
        return { skipped: true };
      }
      // Stale lock — steal the row in place.
      db.prepare(
        'UPDATE phase2_runs SET lock_holder = ?, started_at = ?, input_set_hash = ? WHERE id = ?'
      ).run(token, now, '', running.id);
      return { skipped: false, runId: running.id, token };
    }

    // No running row — insert a new one.
    const result = db
      .prepare(
        'INSERT INTO phase2_runs (started_at, input_set_hash, lock_holder, status) VALUES (?, ?, ?, ?)'
      )
      .run(now, '', token, 'running');
    return { skipped: false, runId: Number(result.lastInsertRowid), token };
  });

  return txn.immediate();
}

function isCasSkip(db: Database, inputSetHash: string): boolean {
  const last = db
    .prepare(
      'SELECT input_set_hash FROM phase2_runs WHERE status = ? ORDER BY id DESC LIMIT 1'
    )
    .get('succeeded') as { input_set_hash: string } | undefined;
  return last?.input_set_hash === inputSetHash;
}

function releaseLock(
  db: Database,
  runId: number,
  token: string,
  now: number,
  status: 'succeeded' | 'failed',
  inputSetHash: string,
  outputDiffSummary: string
): void {
  db.prepare(
    `UPDATE phase2_runs
       SET finished_at = ?, status = ?, input_set_hash = ?,
           output_diff_summary = ?, lock_holder = NULL
     WHERE id = ? AND lock_holder = ?`
  ).run(now, status, inputSetHash, outputDiffSummary, runId, token);
}

// ---------------------------------------------------------------------------
// Stage 1 item parsing
// ---------------------------------------------------------------------------

interface RawMemoryItem {
  claim?: string;
  claim_type?: string;
  evidence?: Array<{
    source_type?: string;
    source_id?: string;
    verification?: string;
  }>;
  canonical_key?: string;
}

function parseStage1Items(db: Database): ParsedItem[] {
  const rows = db
    .prepare(
      `SELECT rollout_id, project_id, raw_memory, generated_at
       FROM stage1_outputs
       WHERE job_status = 'succeeded'
         AND content_outcome IN ('success', 'partial')`
    )
    .all() as Array<{
    rollout_id: string;
    project_id: string;
    raw_memory: string | null;
    generated_at: number;
  }>;

  const items: ParsedItem[] = [];
  for (const row of rows) {
    if (!row.raw_memory) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw_memory);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const parsedObj = parsed as { items?: unknown };
    if (!Array.isArray(parsedObj.items)) continue;

    for (let i = 0; i < parsedObj.items.length; i++) {
      const item = parsedObj.items[i] as RawMemoryItem;
      if (typeof item !== 'object' || item === null) continue;
      if (typeof item.claim !== 'string' || item.claim.length === 0) continue;
      if (typeof item.claim_type !== 'string') continue;
      if (typeof item.canonical_key !== 'string' || item.canonical_key.length === 0) continue;
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) continue;

      const evidence: ParsedEvidence[] = item.evidence
        .filter(
          (ev) =>
            ev !== null &&
            typeof ev === 'object' &&
            typeof ev.source_type === 'string' &&
            typeof ev.source_id === 'string'
        )
        .map((ev) => ({
          source_type: ev.source_type as string,
          source_id: ev.source_id as string,
          verification: ev.verification,
        }));
      if (evidence.length === 0) continue;

      items.push({
        rolloutId: row.rollout_id,
        itemIndex: i,
        claim: item.claim,
        claimType: item.claim_type,
        canonicalKey: item.canonical_key,
        evidence,
        generatedAt: row.generated_at,
        projectId: row.project_id,
        isAdHoc: false,
        content: item.claim,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Ad-hoc digestion
// ---------------------------------------------------------------------------

/**
 * Ad-hoc project prefix regex. Uses `__` (double underscore) as the
 * separator because colons are illegal in Windows filenames. Format:
 *   `project__<uuid>__<name>.md`
 */
const PROJECT_PREFIX_RE = /^project__([0-9a-fA-F-]{36})__(.+)$/;

function scanAdHocFiles(rootDir: string): AdHocFile[] {
  const adHocDir = path.join(rootDir, AD_HOC_DIR_NAME);
  if (!fs.existsSync(adHocDir)) return [];

  const files: AdHocFile[] = [];
  for (const entry of fs.readdirSync(adHocDir)) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = path.join(adHocDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    let scope: 'global' | 'project' = 'global';
    let projectId: string | null = null;
    let filenameForkey = entry;

    const match = PROJECT_PREFIX_RE.exec(entry);
    if (match) {
      scope = 'project';
      projectId = match[1];
      filenameForkey = match[2];
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    files.push({
      filename: entry,
      filePath: fullPath,
      content,
      scope,
      projectId,
      canonicalKey: `ad-hoc:${filenameForkey}`,
    });
  }
  return files;
}

function moveAdHocToDigested(file: AdHocFile, rootDir: string): void {
  const digestedDir = path.join(rootDir, AD_HOC_DIR_NAME, DIGESTED_SUBDIR);
  fs.mkdirSync(digestedDir, { recursive: true });
  const dest = path.join(digestedDir, file.filename);
  try {
    fs.renameSync(file.filePath, dest);
  } catch {
    // Best-effort move; if it fails the file stays and will be
    // re-processed next run (idempotent because canonical_key is
    // unique).
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupItems(items: ParsedItem[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    if (!d8AllowsKind(item)) continue;
    const scope = scopeForProject(item.projectId);
    const projectId = scope === 'global' ? null : item.projectId;
    const key = `${scope}|${projectId ?? ''}|${item.canonicalKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { scope, projectId, canonicalKey: item.canonicalKey, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return Array.from(groups.values());
}

function stage1ItemId(item: ParsedItem): string {
  if (item.isAdHoc) return `ad-hoc#${item.canonicalKey}`;
  return `${item.rolloutId}#${item.itemIndex}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runConsolidator(input: ConsolidatorInput): ConsolidatorResult {
  const start = input.now ?? Date.now();
  const lockTimeoutMs = input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const rootDir = input.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
  const now = (): number => input.now ?? Date.now();

  // Step 1: Acquire global lock.
  const lockResult = acquireLock(input.db, start, lockTimeoutMs);
  if (lockResult.skipped) {
    return {
      skipped: true,
      added: 0,
      merged: 0,
      superseded: 0,
      retired: 0,
      adHocDigested: 0,
      durationMs: now() - start,
    };
  }
  const runId = lockResult.runId;
  const token = lockResult.token;

  // Step 2: Compute input_set_hash.
  const inputSetHash = computeInputSetHash(input.db);

  // Step 3: CAS-skip.
  if (isCasSkip(input.db, inputSetHash)) {
    releaseLock(
      input.db,
      runId,
      token,
      now(),
      'succeeded',
      inputSetHash,
      JSON.stringify({ skipped: true, reason: 'cas-skip' })
    );
    return {
      skipped: true,
      runId,
      added: 0,
      merged: 0,
      superseded: 0,
      retired: 0,
      adHocDigested: 0,
      durationMs: now() - start,
    };
  }

  // Step 4: Parse stage1 items.
  const stage1Items = parseStage1Items(input.db);

  // Step 4b: Scan ad-hoc files.
  const adHocFiles = scanAdHocFiles(rootDir);
  const adHocItems: ParsedItem[] = adHocFiles.map((f) => ({
    rolloutId: 'ad-hoc',
    itemIndex: 0,
    claim: f.content,
    claimType: 'fact',
    canonicalKey: f.canonicalKey,
    evidence: [
      {
        source_type: 'user_message',
        source_id: f.filename,
        verification: 'verified_user',
      },
    ],
    generatedAt: start,
    projectId: f.projectId ?? 'global',
    isAdHoc: true,
    content: f.content,
  }));

  // Step 5: Group items.
  const allItems = [...stage1Items, ...adHocItems];
  const groups = groupItems(allItems);

  // Steps 6-10: single BEGIN IMMEDIATE transaction.
  let transactionCommitted = false;
  let txnResult: {
    added: number;
    merged: number;
    superseded: number;
    retired: number;
  };

  try {
    txnResult = input.db.transaction((): {
      added: number;
      merged: number;
      superseded: number;
      retired: number;
    } => {
      let added = 0;
      let merged = 0;
      let superseded = 0;
      let retired = 0;
      const diffAdded: Phase2DiffEntry[] = [];
      const diffSuperseded: Phase2DiffEntry[] = [];

      // Steps 6-8: per-group UPSERT + evidence.
      for (const group of groups) {
        const winner = pickWinner(group.items);

        // Query existing entry for this canonical_key.
        const existing = group.projectId
          ? (input.db
              .prepare(
                'SELECT * FROM memory_entries WHERE scope = ? AND project_id = ? AND canonical_key = ?'
              )
              .get(group.scope, group.projectId, group.canonicalKey) as
              | MemoryEntryRow
              | undefined)
          : (input.db
              .prepare(
                'SELECT * FROM memory_entries WHERE scope = ? AND project_id IS NULL AND canonical_key = ?'
              )
              .get(group.scope, group.canonicalKey) as
              | MemoryEntryRow
              | undefined);

        let memoryId: string;
        if (!existing) {
          // Step 7: INSERT new entry.
          memoryId = crypto.randomUUID();
          input.db
            .prepare(
              `INSERT INTO memory_entries
                 (memory_id, scope, project_id, kind, canonical_key, content,
                  version, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`
            )
            .run(
              memoryId,
              group.scope,
              group.projectId,
              winner.claimType as MemoryEntryRow['kind'],
              group.canonicalKey,
              winner.content,
              start,
              start
            );
          added++;
          diffAdded.push({
            memory_id: memoryId,
            canonical_key: group.canonicalKey,
            content: winner.content,
            kind: winner.claimType,
            scope: group.scope,
            project_id: group.projectId,
          });
        } else {
          memoryId = existing.memory_id;
          if (existing.content !== winner.content) {
            // Merge: version bump + new content (winner preferred).
            input.db
              .prepare(
                `UPDATE memory_entries
                   SET content = ?, version = version + 1, updated_at = ?, kind = ?
                 WHERE memory_id = ?`
              )
              .run(
                winner.content,
                start,
                winner.claimType as MemoryEntryRow['kind'],
                memoryId
              );
            merged++;
            diffSuperseded.push({
              memory_id: memoryId,
              canonical_key: group.canonicalKey,
              content: winner.content,
              kind: winner.claimType,
              scope: group.scope,
              project_id: group.projectId,
            });
          }
        }

        // Step 8: INSERT evidence rows.
        for (const item of group.items) {
          const itemId = stage1ItemId(item);
          const relation = item === winner ? 'source' : 'supporting';
          input.db
            .prepare(
              `INSERT OR IGNORE INTO memory_evidence
                 (memory_id, rollout_id, stage1_item_id, relation)
               VALUES (?, ?, ?, ?)`
            )
            .run(memoryId, item.rolloutId, itemId, relation);
        }
      }

      // Step 9: Render + enqueue 5 projection files.
      const entries = input.db
        .prepare('SELECT * FROM memory_entries')
        .all() as MemoryEntryRow[];
      const projects = input.db
        .prepare('SELECT * FROM projects')
        .all() as ProjectRow[];

      const projectIds = new Set(
        entries
          .filter((e) => e.scope === 'project' && e.project_id !== null)
          .map((e) => e.project_id as string)
      );

      // global/MEMORY.md
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'global', 'MEMORY.md'),
        operation: 'write',
        content: renderGlobalMemoryFile(entries),
        now: start,
      });

      // projects/<id>/MEMORY.md
      for (const pid of projectIds) {
        enqueueProjectionOutbox(input.db, {
          targetPath: path.join(rootDir, 'projects', pid, 'MEMORY.md'),
          operation: 'write',
          content: renderProjectMemoryFile(entries, pid),
          now: start,
        });
      }

      // global/summary.md
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'global', 'summary.md'),
        operation: 'write',
        content: renderGlobalSummaryFile(entries, projects),
        now: start,
      });

      // projects/<id>/summary.md
      for (const pid of projectIds) {
        enqueueProjectionOutbox(input.db, {
          targetPath: path.join(rootDir, 'projects', pid, 'summary.md'),
          operation: 'write',
          content: renderProjectSummaryFile(entries, pid),
          now: start,
        });
      }

      // phase2_workspace_diff.md
      const diff: Phase2Diff = {
        added: diffAdded,
        superseded: diffSuperseded,
        retired: [],
        runId,
        inputHash: inputSetHash,
        timestamp: start,
      };
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'phase2_workspace_diff.md'),
        operation: 'write',
        content: renderPhase2WorkspaceDiff(diff),
        now: start,
      });

      // Step 10: UPDATE phase2_runs + release lock.
      const outputDiffSummary = JSON.stringify(diff);
      input.db
        .prepare(
          `UPDATE phase2_runs
             SET finished_at = ?, status = 'succeeded',
                 input_set_hash = ?, output_diff_summary = ?,
                 lock_holder = NULL
           WHERE id = ? AND lock_holder = ?`
        )
        .run(start, inputSetHash, outputDiffSummary, runId, token);

      return { added, merged, superseded, retired };
    }).immediate();

    transactionCommitted = true;
  } finally {
    if (!transactionCommitted) {
      // Transaction failed/rolled back — release the lock as 'failed'.
      try {
        releaseLock(
          input.db,
          runId,
          token,
          now(),
          'failed',
          inputSetHash,
          JSON.stringify({ error: 'transaction-failed' })
        );
      } catch {
        // Best-effort release; the lock will eventually go stale and
        // be stolen by the next run.
      }
    }
  }

  // Move ad-hoc files to .digested/ after successful transaction.
  for (const file of adHocFiles) {
    moveAdHocToDigested(file, rootDir);
  }

  return {
    skipped: false,
    runId,
    added: txnResult.added,
    merged: txnResult.merged,
    superseded: txnResult.superseded,
    retired: txnResult.retired,
    adHocDigested: adHocFiles.length,
    durationMs: now() - start,
  };
}

/**
 * snapshot-gc - sweep unreferenced pre-image snapshot blobs
 *
 * Plan 429 #3 (清理策略): snapshot blobs live forever once written; this
 * sweeper ties their lifecycle to the rollout files that reference them.
 * A blob is deletable when no rollout file mentions its sha256 address
 * anymore (its owning turn was truncated away or its session deleted) AND it
 * is older than a grace period (in-flight edits persist their referencing
 * tool_result message slightly AFTER the blob lands on disk).
 *
 * Mark phase = regex scan of rollout JSONL for 64-hex tokens. This is cheap,
 * dependency-free, and robust to payload shape changes: any metadata key
 * referencing `<sha>.blob` keeps the blob alive. Sweep runs at startup
 * (delayed, fire-and-forget) and is safe to run concurrently with app use:
 * worst case a just-deleted reference's blob survives until the next sweep.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

const SHA_RE = /\b[0-9a-f]{64}\b/g;

export interface SweepOptions {
  /** Directory containing `<sha256>.blob` files. */
  snapshotRoot: string;
  /** Directory containing `sessions/**\/*.jsonl` rollout files. */
  rolloutsRoot: string;
  /** Blobs younger than this are never deleted (default 24h). */
  minAgeMs?: number;
}

export interface SweepResult {
  /** Blobs examined. */
  scanned: number;
  /** Blobs deleted (unreferenced + old enough). */
  deleted: number;
  /** Blobs kept (referenced or too young). */
  kept: number;
}

/** Recursively collect *.jsonl files under `dir`. Missing dir → empty list. */
async function listRolloutFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRolloutFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Sweep unreferenced snapshot blobs. See module docs for the policy.
 * Best-effort: IO failures on individual blobs are counted as `kept`.
 */
export async function sweepUnreferencedSnapshots(opts: SweepOptions): Promise<SweepResult> {
  const minAgeMs = opts.minAgeMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();

  // ── Collect candidate blobs (old enough to be considered) ──
  let blobEntries;
  try {
    blobEntries = await fs.readdir(opts.snapshotRoot, { withFileTypes: true });
  } catch {
    return { scanned: 0, deleted: 0, kept: 0 };
  }

  const candidates: Array<{ name: string; sha: string }> = [];
  for (const entry of blobEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.blob')) continue;
    const sha = entry.name.slice(0, -'.blob'.length);
    if (!/^[0-9a-f]{64}$/.test(sha)) continue;
    candidates.push({ name: entry.name, sha });
  }

  if (candidates.length === 0) {
    return { scanned: 0, deleted: 0, kept: 0 };
  }

  // ── Age filter ──
  const referencedOrYoung = new Set<string>();
  const agedCandidates: Array<{ name: string; sha: string }> = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(opts.snapshotRoot, candidate.name));
      if (now - stat.mtimeMs < minAgeMs) {
        referencedOrYoung.add(candidate.sha);
        continue;
      }
    } catch {
      // Vanished mid-sweep — treat as handled.
      referencedOrYoung.add(candidate.sha);
      continue;
    }
    agedCandidates.push(candidate);
  }

  if (agedCandidates.length === 0) {
    return { scanned: candidates.length, deleted: 0, kept: candidates.length };
  }

  // ── Mark phase: scan rollouts for any 64-hex reference ──
  const referenced = new Set<string>();
  const rolloutFiles = await listRolloutFiles(opts.rolloutsRoot);
  for (const file of rolloutFiles) {
    try {
      const content = await fs.readFile(file, 'utf8');
      for (const match of content.matchAll(SHA_RE)) {
        referenced.add(match[0]);
      }
    } catch {
      // Unreadable rollout — skip; conservative effect only.
    }
  }

  // ── Sweep phase ──
  let deleted = 0;
  let kept = 0;
  for (const candidate of agedCandidates) {
    if (referenced.has(candidate.sha) || referencedOrYoung.has(candidate.sha)) {
      kept++;
      continue;
    }
    try {
      await fs.unlink(path.join(opts.snapshotRoot, candidate.name));
      deleted++;
    } catch (err) {
      logger.warn(
        'Snapshot GC failed to delete blob',
        { blob: candidate.name, error: err instanceof Error ? err.message : String(err) },
        LogComponent.Main,
      );
      kept++;
    }
  }

  if (deleted > 0) {
    logger.info(
      'Snapshot GC swept unreferenced blobs',
      { scanned: candidates.length, deleted, kept },
      LogComponent.Main,
    );
  }

  return { scanned: candidates.length, deleted, kept };
}

/**
 * file-snapshot-restore - restore pre-image snapshots on session rewind
 *
 * Plan 429 #3 (rewind 联动): Edit/Write/ApplyPatch persist a content-addressed
 * pre-image snapshot (`~/.duya/snapshots/<sha256>.blob`, see the agent core's
 * FileSnapshotStore) and record the address in the tool-result message
 * metadata:
 *   - Edit / Write → `{ filePath, preImageSha }`
 *   - ApplyPatch   → `{ fileSnapshots: [{ path, preImageSha }] }` (multi-file)
 *
 * When a session is rewound past those tool calls, this module reads the
 * metadata out of the truncated rollout payloads and writes each pre-image
 * back to disk so files roll back together with the conversation timeline.
 *
 * Semantics:
 *   - Restores are best-effort: a missing blob or unwritable target is logged
 *     and counted, never thrown.
 *   - For any path touched multiple times inside the rewound span, the
 *     pre-image of the OLDEST edit wins (it is the state before the whole
 *     span) — see {@link collapseOldestPreImages}.
 *   - Only absolute paths are accepted. The tools already resolved and
 *     validated every recorded path against the session working directory /
 *     allowed roots at write time, so no cwd resolution happens here.
 *   - A "created-new" file has no preImageSha (nothing to restore); deleting
 *     created files on rewind is deliberately NOT done — it would destroy data
 *     the user may have edited outside the agent after creation.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger, LogComponent } from '../logging/logger';

const logger = getLogger();

/** One file-to-restore reference extracted from tool-result metadata. */
export interface PreImageRef {
  /** Absolute path of the file as recorded by the mutating tool. */
  filePath: string;
  /** sha256 hex address of the pre-image content. */
  sha: string;
}

/** Result summary of a restore pass. */
export interface RestoreOutcome {
  /** Files successfully written back to their pre-image. */
  restoredFiles: string[];
  /** References that could not be restored (missing blob, IO error, …). */
  failedCount: number;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * Extract pre-image refs from one tool-result `metadata` object. Tolerant:
 * anything malformed is skipped rather than throwing.
 */
export function extractPreImagesFromMetadata(metadata: unknown): PreImageRef[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const md = metadata as Record<string, unknown>;
  const refs: PreImageRef[] = [];

  // Edit / Write shape: { filePath, preImageSha }
  if (typeof md.filePath === 'string' && path.isAbsolute(md.filePath) && isSha256(md.preImageSha)) {
    refs.push({ filePath: md.filePath, sha: md.preImageSha });
  }

  // ApplyPatch multi-file shape: { fileSnapshots: [{ path, preImageSha }] }
  if (Array.isArray(md.fileSnapshots)) {
    for (const item of md.fileSnapshots) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.path === 'string' && path.isAbsolute(entry.path) && isSha256(entry.preImageSha)) {
        refs.push({ filePath: entry.path, sha: entry.preImageSha });
      }
    }
  }

  return refs;
}

/**
 * Extract pre-image refs from one persisted rollout payload. The payload is a
 * serialized MessageEntry whose AgentMessage carries the original tool-result
 * metadata. Tolerant to legacy/flat shapes: metadata is looked up on
 * `entry.message.metadata` first, then `entry.metadata`.
 *
 * Returns an empty array for non-tool payloads (user/assistant text, runtime
 * context) which never carry snapshot metadata.
 */
export function collectPreImages(payload: unknown): PreImageRef[] {
  if (!payload || typeof payload !== 'object') return [];
  const entry = payload as {
    message?: { metadata?: unknown };
    metadata?: unknown;
  };
  const metadata = entry.message?.metadata ?? entry.metadata;
  return extractPreImagesFromMetadata(metadata);
}

/**
 * Collect pre-image refs from persisted event rows (newest-first order is the
 * caller's responsibility — see {@link buildNewestFirstRefs}).
 */
function parsePayloads(events: Array<{ payload: string }>): PreImageRef[] {
  const refs: PreImageRef[] = [];
  for (const event of events) {
    try {
      refs.push(...collectPreImages(JSON.parse(event.payload)));
    } catch {
      // Unparseable payload — nothing to restore from this row.
    }
  }
  return refs;
}

/**
 * Collapse refs per path, keeping only the OLDEST edit's pre-image for each
 * file: within the rewound span every later edit started from the previous
 * one's result, so the earliest pre-image is exactly the state before the
 * whole span. Returns one ref per touched path, in first-seen (oldest) order.
 */
/**
 * Collapse refs to one pre-image per touched path (the oldest edit's).
 */
export function collapseOldestPreImages(oldestFirstRefs: PreImageRef[]): PreImageRef[] {
  const oldestByPath = new Map<string, PreImageRef>();
  for (const ref of oldestFirstRefs) {
    if (!oldestByPath.has(ref.filePath)) {
      oldestByPath.set(ref.filePath, ref);
    }
  }
  return [...oldestByPath.values()];
}

/** Default snapshot root: `<rollout root>/snapshots` (mirrors the agent core). */
export function defaultSnapshotRoot(): string {
  // Lazy require keeps this module importable in unit tests without electron.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveRolloutRoot } = require('../config/boot-config') as typeof import('../config/boot-config');
  return path.join(resolveRolloutRoot(), 'snapshots');
}

/**
 * Restore pre-images back to disk. `refs` should already be collapsed per
 * path (see {@link collapseOldestPreImages}); each ref is written once.
 * Best-effort: individual failures are counted and logged, never thrown.
 */
export async function restorePreImages(
  refs: PreImageRef[],
  snapshotRoot: string = defaultSnapshotRoot(),
): Promise<RestoreOutcome> {
  const restoredFiles: string[] = [];
  let failedCount = 0;

  for (const ref of refs) {
    try {
      const blobPath = path.join(snapshotRoot, `${ref.sha}.blob`);
      const content = await fs.readFile(blobPath, 'utf8');

      // Integrity check: only write back content whose hash matches the
      // address — a corrupted/truncated blob must never clobber user files.
      const actualSha = createHash('sha256').update(content).digest('hex');
      if (actualSha !== ref.sha) {
        logger.warn(
          'Snapshot blob hash mismatch, skipping restore',
          { filePath: ref.filePath, expected: ref.sha },
          LogComponent.Main,
        );
        failedCount++;
        continue;
      }

      await fs.mkdir(path.dirname(ref.filePath), { recursive: true });
      await fs.writeFile(ref.filePath, content, 'utf8');
      restoredFiles.push(ref.filePath);
    } catch (err) {
      failedCount++;
      logger.warn(
        'Failed to restore pre-image snapshot',
        { filePath: ref.filePath, error: err instanceof Error ? err.message : String(err) },
        LogComponent.Main,
      );
    }
  }

  return { restoredFiles, failedCount };
}

/**
 * Restore all pre-images referenced by `events` (the rows about to be removed
 * by a truncate/rewind, oldest-first as returned by `listBySession`).
 */
export async function restoreFilesForEvents(
  events: Array<{ payload: string }>,
  snapshotRoot?: string,
): Promise<RestoreOutcome> {
  const refs = collapseOldestPreImages(parsePayloads(events));
  if (refs.length === 0) return { restoredFiles: [], failedCount: 0 };
  return restorePreImages(refs, snapshotRoot);
}

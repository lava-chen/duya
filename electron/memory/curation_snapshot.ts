import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Pre-publish snapshot manager (design §11.2).
 *
 * Before each successful publication, a full snapshot of managed memory
 * files is taken to `~/.duya/memory-snapshots/<timestamp>/`. Snapshots
 * live OUTSIDE the memory root so they are never recursively scanned
 * by the runtime agent.
 *
 * Content-hash deduplication: identical files across snapshots share
 * storage via hardlinks, so N snapshots of an unchanged file cost only
 * one copy on disk.
 *
 * Retention: the last `maxSnapshots` (default 5) full snapshot
 * directories are kept; older ones are deleted.
 */

const EXCLUDED_MEMORY_DIRS = new Set([
  'rollout_summaries',
  'extensions',
  'archive',
  'snapshots',
]);

export interface CreateSnapshotOpts {
  liveMemoryRoot: string;
  liveConfigRoot: string;
  snapshotRoot: string;
  maxSnapshots?: number;
}

export interface CreateSnapshotResult {
  snapshotDir: string;
  manifestHash: string;
}

/**
 * Create a snapshot of the current live memory + config state.
 *
 * Layout:
 *   snapshotRoot/<timestamp>/
 *   ├── memory/         # items/ + entities/ + MEMORY.md + summary.md + .manifest.json
 *   └── memory-config/  # stage1_policy.md + memory_layout.json
 *
 * Returns the snapshot directory path and a manifest hash of all
 * snapshot content.
 */
export async function createSnapshot(opts: CreateSnapshotOpts): Promise<CreateSnapshotResult> {
  const maxSnapshots = opts.maxSnapshots ?? 5;
  const timestamp = formatSnapshotTimestamp(new Date());
  const snapshotDir = path.join(opts.snapshotRoot, timestamp);

  await fsp.mkdir(path.join(snapshotDir, 'memory'), { recursive: true });
  await fsp.mkdir(path.join(snapshotDir, 'memory-config'), { recursive: true });

  // Content store for hardlink dedup: snapshotRoot/.content/<hash>
  const contentStore = path.join(opts.snapshotRoot, '.content');
  await fsp.mkdir(contentStore, { recursive: true });

  // Copy managed memory files with dedup.
  await snapshotDirWithDedup(
    opts.liveMemoryRoot,
    path.join(snapshotDir, 'memory'),
    contentStore,
    (entryName) => {
      // Include items/, entities/, MEMORY.md, summary.md, .manifest.json.
      // Exclude rollout_summaries/, extensions/, etc.
      if (EXCLUDED_MEMORY_DIRS.has(entryName)) return false;
      if (entryName === 'index.md') return true; // entity index.md files are managed
      return true;
    }
  );

  // Copy config files with dedup.
  await snapshotDirWithDedup(
    opts.liveConfigRoot,
    path.join(snapshotDir, 'memory-config'),
    contentStore,
    () => true
  );

  // Compute manifest hash.
  const manifestHash = await computeSnapshotHash(snapshotDir);

  // Prune old snapshots.
  await pruneOldSnapshots(opts.snapshotRoot, maxSnapshots);

  return { snapshotDir, manifestHash };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSnapshotTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `_${d.getMilliseconds().toString().padStart(3, '0')}`
  );
}

/**
 * Copy a directory tree to dest, using hardlinks from the content store
 * when the file content already exists. This deduplicates identical
 * files across snapshots.
 */
async function snapshotDirWithDedup(
  src: string,
  dest: string,
  contentStore: string,
  shouldInclude: (entryName: string) => boolean,
): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fsp.mkdir(dest, { recursive: true });

  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!shouldInclude(entry.name)) continue;

    // Skip excluded top-level dirs.
    if (entry.isDirectory() && EXCLUDED_MEMORY_DIRS.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await snapshotDirWithDedup(srcPath, destPath, contentStore, shouldInclude);
    } else if (entry.isFile()) {
      const content = await fsp.readFile(srcPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const storePath = path.join(contentStore, hash);

      // The content store is the canonical copy. Write it first so every
      // snapshot file is a hardlink to the same inode — N snapshots of an
      // unchanged file share storage and report identical inodes.
      if (!fs.existsSync(storePath)) {
        await fsp.writeFile(storePath, content);
      }

      // Hardlink the store file into the snapshot; fall back to a copy
      // if hardlinking fails (cross-device, permissions).
      try {
        await fsp.link(storePath, destPath);
      } catch {
        await fsp.writeFile(destPath, content);
      }
    }
  }
}

/**
 * Compute a deterministic hash over all files in a snapshot directory.
 */
async function computeSnapshotHash(snapshotDir: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(dir: string): Promise<void> {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const content = await fsp.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const relPath = path.relative(snapshotDir, fullPath).split(path.sep).join('/');
        entries.push({ relPath, fileHash });
      }
    }
  }

  await walk(snapshotDir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const payload = entries.map((e) => `${e.relPath}\0${e.fileHash}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Delete old snapshot directories, keeping only the most recent
 * `maxSnapshots`. Directories are named by timestamp (sortable).
 */
async function pruneOldSnapshots(snapshotRoot: string, maxSnapshots: number): Promise<void> {
  if (!fs.existsSync(snapshotRoot)) return;

  const entries = await fsp.readdir(snapshotRoot, { withFileTypes: true });
  const snapshotDirs = entries
    .filter((e) => e.isDirectory() && e.name !== 'manifests' && e.name !== '.content')
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first

  const toDelete = snapshotDirs.slice(maxSnapshots);
  for (const dirName of toDelete) {
    await fsp.rm(path.join(snapshotRoot, dirName), { recursive: true, force: true });
  }
}
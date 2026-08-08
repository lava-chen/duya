import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Curation staging workspace manager (design §4 + §8.4 step 3).
 *
 * Creates an isolated copy of managed memory files + a frozen snapshot
 * of input evidence for a single curation run. The staging workspace is
 * the only filesystem the curator agent process can see (root-bound
 * tool instances, design §7.2).
 */

// Directories under memoryRoot that are NOT managed memory files
// (rollout evidence, user-authored notes, archive, snapshots). These
// are excluded from the staging copy.
const EXCLUDED_MEMORY_DIRS = new Set([
  'rollout_summaries',
  'extensions',
  'archive',
  'snapshots',
]);

export interface StagingInput {
  inputKind: 'rollout' | 'ad_hoc';
  inputKey: string;
  contentHash: string;
  sourcePath: string;
}

export interface CreateStagingOpts {
  memoryRoot: string;
  configRoot: string;
  inputs: StagingInput[];
}

export interface CreateStagingResult {
  stagingDir: string;
  manifestHash: string;
}

/**
 * Create a staging workspace at `stagingRoot/<runId>/`.
 *
 * Layout:
 *   stagingRoot/<runId>/
 *   ├── memory/             # items/ + entities/ + .manifest.json (from memoryRoot)
 *   ├── memory-config/      # stage1_policy.md + memory_layout.json (from configRoot)
 *   ├── inputs/
 *   │   ├── rollout/        # frozen rollout evidence files
 *   │   └── ad_hoc/         # frozen ad_hoc note files
 *   └── backup/             # empty, filled during publish step 7
 *
 * Symlinks are skipped (never followed, never copied) to prevent path
 * escape. The manifestHash is a sha256 over all staged files' content
 * hashes sorted by relative path — deterministic for identical content.
 */
export async function createStaging(
  stagingRoot: string,
  runId: string,
  opts: CreateStagingOpts
): Promise<CreateStagingResult> {
  const stagingDir = path.join(stagingRoot, runId);

  try {
    // 1. Create directory structure.
    await fsp.mkdir(stagingDir, { recursive: true });
    await fsp.mkdir(path.join(stagingDir, 'memory'), { recursive: true });
    await fsp.mkdir(path.join(stagingDir, 'memory-config'), { recursive: true });
    await fsp.mkdir(path.join(stagingDir, 'inputs', 'rollout'), { recursive: true });
    await fsp.mkdir(path.join(stagingDir, 'inputs', 'ad_hoc'), { recursive: true });
    await fsp.mkdir(path.join(stagingDir, 'backup'), { recursive: true });

    // 2. Copy managed memory files (items/ + entities/ + .manifest.json).
    for (const name of ['items', 'entities']) {
      const src = path.join(opts.memoryRoot, name);
      if (await pathExists(src)) {
        await copyDirSkippingSymlinks(src, path.join(stagingDir, 'memory', name));
      }
    }
    const manifestSrc = path.join(opts.memoryRoot, '.manifest.json');
    if (await pathExists(manifestSrc)) {
      await fsp.copyFile(manifestSrc, path.join(stagingDir, 'memory', '.manifest.json'));
    }

    // 3. Copy config root (stage1_policy.md + memory_layout.json + any
    //    policy_proposals/ or .canary/ that may exist).
    await copyDirSkippingSymlinks(opts.configRoot, path.join(stagingDir, 'memory-config'));

    // 4. Freeze input evidence files.
    for (const inp of opts.inputs) {
      const destDir = inp.inputKind === 'rollout'
        ? path.join(stagingDir, 'inputs', 'rollout')
        : path.join(stagingDir, 'inputs', 'ad_hoc');
      // Preserve the source file's basename (including extension) so the
      // frozen evidence keeps its original filename.
      const destName = path.basename(inp.sourcePath);
      const dest = path.join(destDir, destName);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(inp.sourcePath, dest);
    }

    // 5. Compute manifest hash over all files (excluding backup/).
    const manifestHash = await computeManifestHash(stagingDir);

    return { stagingDir, manifestHash };
  } catch (err) {
    // A failed create must not leave a partial workspace (empty directory
    // skeleton) behind — otherwise empty dirs accumulate under stagingRoot.
    await deleteStaging(stagingDir);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// deleteStaging
// ---------------------------------------------------------------------------

/**
 * Recursively delete a staging workspace. Safe to call on a non-existent
 * directory (no-op, does not throw).
 */
export async function deleteStaging(stagingDir: string): Promise<void> {
  await fsp.rm(stagingDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// validateStagingIntact
// ---------------------------------------------------------------------------

/**
 * Verify that the staging workspace has not been modified since
 * `createStaging` returned `expectedManifestHash`.
 *
 * Recomputes the manifest hash and compares. Returns true when the
 * staging is intact, false when any file has been added, removed, or
 * modified (excluding the backup/ directory, which is filled during
 * publish step 7 and is not part of the manifest).
 */
export async function validateStagingIntact(
  stagingDir: string,
  expectedManifestHash: string
): Promise<boolean> {
  const currentHash = await computeManifestHash(stagingDir);
  return currentHash === expectedManifestHash;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy a directory, skipping all symlinks (both as top-level
 * entries and as nested entries). This is the symlink-escape defense.
 */
async function copyDirSkippingSymlinks(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip symlinks entirely.
    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      // Skip excluded memory dirs.
      if (EXCLUDED_MEMORY_DIRS.has(entry.name)) continue;
      await copyDirSkippingSymlinks(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Compute a deterministic manifest hash over all files in the staging
 * directory (excluding backup/).
 *
 * Algorithm:
 *   1. Walk stagingDir recursively, collecting all files.
 *   2. Exclude the backup/ directory.
 *   3. For each file: compute sha256 of its content.
 *   4. Sort entries by relative path (posix-style).
 *   5. Concatenate: `${relPath}\0${fileSha256}\n`.
 *   6. Return sha256 of the concatenation.
 */
export async function computeManifestHash(stagingDir: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];
  const backupDir = path.join(stagingDir, 'backup');

  async function walk(dir: string): Promise<void> {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (fullPath === backupDir) continue;
        await walk(fullPath);
      } else if (item.isFile()) {
        const content = await fsp.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const relPath = path.relative(stagingDir, fullPath).split(path.sep).join('/');
        entries.push({ relPath, fileHash });
      }
    }
  }

  await walk(stagingDir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const payload = entries.map((e) => `${e.relPath}\0${e.fileHash}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}
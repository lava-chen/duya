import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { generateMemoryMd, generateSummaryMd, generateIndexMd } from '../../packages/agent/src/memory-state/curation_projection';

/**
 * Crash-safe publication state machine (design §8.2–§8.5).
 *
 * The publication protocol uses a journal file that is fsync'd after
 * every step. On crash recovery, the journal tells the worker exactly
 * which steps completed and which need to be replayed or rolled back.
 *
 * State machine:
 *   prepared → publishing → filesystem_committed → cache_pending → succeeded
 *
 * The journal is written to `memory-staging/<run_id>/publication.journal.json`
 * and contains one entry per publication step with its status.
 */

// ---------------------------------------------------------------------------
// Types (design §8.3)
// ---------------------------------------------------------------------------

export type PublicationStepName =
  | 'backup_old'
  | 'move_leaf'
  | 'move_config'
  | 'regenerate_indexes'
  | 'regenerate_MEMORY_md'
  | 'regenerate_summary_md'
  | 'swap_manifest';

export type StepStatus = 'pending' | 'done' | 'failed';

export interface PublicationJournalStep {
  step: PublicationStepName;
  files?: string[];
  path?: string;
  status: StepStatus;
  ts: string | null;
}

export interface PublicationJournal {
  run_id: string;
  generation: number;
  old_manifest_hash: string;
  new_manifest_hash: string;
  old_policy_version: number | null;
  new_policy_version: number | null;
  old_layout_version: number | null;
  new_layout_version: number | null;
  steps: PublicationJournalStep[];
  backup_dir: string;
}

// ---------------------------------------------------------------------------
// writeJournal / readJournal
// ---------------------------------------------------------------------------

/**
 * Write the publication journal to disk with fsync.
 *
 * The journal is written atomically: write to a temp file, fsync, then
 * rename over the target. This ensures the journal is never partially
 * written even if the process crashes mid-write.
 */
export function writeJournal(journalPath: string, journal: PublicationJournal): void {
  const dir = path.dirname(journalPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = journalPath + '.tmp';
  const data = JSON.stringify(journal, null, 2);

  // Write to temp file.
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Atomic rename.
  fs.renameSync(tmpPath, journalPath);
}

/**
 * Read a publication journal from disk. Returns null if the journal
 * file does not exist (no publication in progress).
 */
export function readJournal(journalPath: string): PublicationJournal | null {
  if (!fs.existsSync(journalPath)) return null;
  try {
    const data = fs.readFileSync(journalPath, 'utf8');
    return JSON.parse(data) as PublicationJournal;
  } catch {
    // Corrupt journal — treat as non-existent so recovery can clean up.
    return null;
  }
}

// ---------------------------------------------------------------------------
// preparePublication (design §8.4 step 7)
// ---------------------------------------------------------------------------

export interface PreparePublicationOpts {
  runId: string;
  stagingDir: string;
  liveMemoryRoot: string;
  liveConfigRoot: string;
  oldManifestHash: string;
  generation: number;
  oldPolicyVersion?: number | null;
  newPolicyVersion?: number | null;
  oldLayoutVersion?: number | null;
  newLayoutVersion?: number | null;
}

/**
 * Prepare a publication: back up live files, generate candidate
 * projections, and write the initial journal (state: prepared).
 *
 * No live files are touched. All candidate content is written to
 * `stagingDir/candidate/`. The journal is fsync'd with all steps
 * 'pending' except 'backup_old' which is 'done'.
 */
export async function preparePublication(opts: PreparePublicationOpts): Promise<PublicationJournal> {
  const backupDir = path.join(opts.stagingDir, 'backup');
  const candidateDir = path.join(opts.stagingDir, 'candidate');
  const stagingMemory = path.join(opts.stagingDir, 'memory');

  // 1. Copy live files that will be replaced into backup/.
  await fsp.mkdir(backupDir, { recursive: true });
  await copyManagedFiles(opts.liveMemoryRoot, backupDir);
  // Also back up config (layout may change).
  await copyManagedFiles(opts.liveConfigRoot, path.join(backupDir, '_config'));

  // 2. Generate candidate projections from staging memory.
  await fsp.mkdir(path.join(candidateDir, 'entities'), { recursive: true });

  const memoryMd = generateMemoryMd(stagingMemory);
  const summaryMd = generateSummaryMd(stagingMemory);

  await writeAtomic(path.join(candidateDir, 'MEMORY.md'), memoryMd);
  await writeAtomic(path.join(candidateDir, 'summary.md'), summaryMd);

  // Generate index.md for each entity type directory in staging.
  const entitiesDir = path.join(stagingMemory, 'entities');
  if (fs.existsSync(entitiesDir)) {
    for (const entry of fs.readdirSync(entitiesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const indexMd = generateIndexMd(stagingMemory, entry.name);
        if (indexMd) {
          await writeAtomic(path.join(candidateDir, 'entities', entry.name, 'index.md'), indexMd);
        }
      }
    }
  }

  // 3. Compute new manifest hash (hash of all staging memory files).
  const newManifestHash = await computeDirectoryHash(stagingMemory);

  // 4. Build journal with all steps pending.
  const now = new Date().toISOString();
  const journal: PublicationJournal = {
    run_id: opts.runId,
    generation: opts.generation,
    old_manifest_hash: opts.oldManifestHash,
    new_manifest_hash: newManifestHash,
    old_policy_version: opts.oldPolicyVersion ?? null,
    new_policy_version: opts.newPolicyVersion ?? null,
    old_layout_version: opts.oldLayoutVersion ?? null,
    new_layout_version: opts.newLayoutVersion ?? null,
    backup_dir: backupDir,
    steps: [
      { step: 'backup_old', path: backupDir, status: 'done', ts: now },
      { step: 'move_leaf', files: [], status: 'pending', ts: null },
      { step: 'move_config', files: [], status: 'pending', ts: null },
      { step: 'regenerate_indexes', files: [], status: 'pending', ts: null },
      { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
      { step: 'regenerate_summary_md', status: 'pending', ts: null },
      { step: 'swap_manifest', status: 'pending', ts: null },
    ],
  };

  // 5. Write journal (fsync'd).
  writeJournal(path.join(opts.stagingDir, 'publication.journal.json'), journal);

  return journal;
}

// ---------------------------------------------------------------------------
// executePublication (design §8.4 step 8)
// ---------------------------------------------------------------------------

export interface ExecutePublicationOpts {
  stagingDir: string;
  liveMemoryRoot: string;
  liveConfigRoot: string;
}

/**
 * Execute the publication: move canonical files from staging to live,
 * regenerate projections from candidate, and swap the manifest atomically.
 *
 * Each step is performed in journal order:
 *   1. move_leaf      — copy/replace staging memory files into live
 *   2. move_config    — copy staging config files into live (if changed)
 *   3. regenerate_indexes — copy candidate index.md files into live
 *   4. regenerate_MEMORY_md — copy candidate MEMORY.md into live
 *   5. regenerate_summary_md — copy candidate summary.md into live
 *   6. swap_manifest   — write new .manifest.json atomically
 *
 * After each step: fsync written files, update journal step='done', fsync journal.
 * The manifest swap is the commit point (state: filesystem_committed).
 */
export async function executePublication(
  journal: PublicationJournal,
  opts: ExecutePublicationOpts
): Promise<void> {
  const journalPath = path.join(opts.stagingDir, 'publication.journal.json');
  const stagingMemory = path.join(opts.stagingDir, 'memory');
  const candidateDir = path.join(opts.stagingDir, 'candidate');

  for (const step of journal.steps) {
    if (step.status === 'done') continue;

    switch (step.step) {
      case 'backup_old':
        // Already done during preparePublication.
        break;

      case 'move_leaf':
        await syncDirectory(stagingMemory, opts.liveMemoryRoot, ['items', 'entities']);
        break;

      case 'move_config':
        await syncConfig(opts.stagingDir, opts.liveConfigRoot);
        break;

      case 'regenerate_indexes':
        await syncCandidateIndexes(candidateDir, opts.liveMemoryRoot);
        break;

      case 'regenerate_MEMORY_md':
        await writeAtomic(
          path.join(opts.liveMemoryRoot, 'MEMORY.md'),
          fs.readFileSync(path.join(candidateDir, 'MEMORY.md'), 'utf8')
        );
        break;

      case 'regenerate_summary_md':
        await writeAtomic(
          path.join(opts.liveMemoryRoot, 'summary.md'),
          fs.readFileSync(path.join(candidateDir, 'summary.md'), 'utf8')
        );
        break;

      case 'swap_manifest': {
        const manifest = {
          version: 1,
          generation: journal.generation,
          manifest_hash: journal.new_manifest_hash,
          updated_at: new Date().toISOString(),
        };
        await writeAtomic(
          path.join(opts.liveMemoryRoot, '.manifest.json'),
          JSON.stringify(manifest, null, 2)
        );
        break;
      }
    }

    // Update journal step.
    step.status = 'done';
    step.ts = new Date().toISOString();
    writeJournal(journalPath, journal);
  }
}

/**
 * Sync directories from src to dest: copy new/modified files, delete
 * files that exist in dest but not in src. Only syncs the specified
 * subdirectories.
 */
async function syncDirectory(src: string, dest: string, subdirs: string[]): Promise<void> {
  for (const sub of subdirs) {
    const srcSub = path.join(src, sub);
    const destSub = path.join(dest, sub);
    if (fs.existsSync(srcSub)) {
      await syncDirRecursive(srcSub, destSub);
    } else {
      // Subdir deleted in staging — remove from live.
      if (fs.existsSync(destSub)) {
        await fsp.rm(destSub, { recursive: true, force: true });
      }
    }
  }
}

async function syncDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });

  // Track which dest files should survive (those present in src).
  const srcEntries = new Set<string>();
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    srcEntries.add(entry.name);
    if (entry.isDirectory()) {
      await syncDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }

  // Delete files in dest that are not in src.
  if (fs.existsSync(dest)) {
    const destEntries = await fsp.readdir(dest, { withFileTypes: true });
    for (const entry of destEntries) {
      if (!srcEntries.has(entry.name)) {
        await fsp.rm(path.join(dest, entry.name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Sync config files from staging/memory-config/ to live config root.
 */
async function syncConfig(stagingDir: string, liveConfigRoot: string): Promise<void> {
  const stagingConfig = path.join(stagingDir, 'memory-config');
  if (!fs.existsSync(stagingConfig)) return;
  await syncDirRecursive(stagingConfig, liveConfigRoot);
}

/**
 * Copy index.md files from candidate/entities/ to live entities/.
 */
async function syncCandidateIndexes(candidateDir: string, liveMemoryRoot: string): Promise<void> {
  const candidateEntities = path.join(candidateDir, 'entities');
  if (!fs.existsSync(candidateEntities)) return;

  for (const entry of fs.readdirSync(candidateEntities, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexSrc = path.join(candidateEntities, entry.name, 'index.md');
    if (fs.existsSync(indexSrc)) {
      const indexDest = path.join(liveMemoryRoot, 'entities', entry.name, 'index.md');
      await writeAtomic(indexDest, fs.readFileSync(indexSrc, 'utf8'));
    }
  }
}

// ---------------------------------------------------------------------------
// recoverPublication (design §8.5)
// ---------------------------------------------------------------------------

export type RecoveryAction = 'noop' | 'discard' | 'restore' | 'finalize' | 'retry_cache';

export interface RecoveryResult {
  action: RecoveryAction;
  runId?: string;
  journal?: PublicationJournal;
}

/**
 * Recover from an interrupted publication.
 *
 * Reads the journal and determines the recovery action per the §8.5 table:
 *
 *   journal not found                     → noop
 *   prepared (backup_old done, rest pending) → discard staging, mark failed
 *   publishing (some steps done, manifest not swapped) → restore from backup
 *   filesystem_committed (manifest swapped) → finalize DB (caller calls completeRun)
 *   cache_pending                         → retry cache rebuild (caller handles)
 *
 * For 'restore': copies backup files back to live and removes any files
 * that were added during the partial publish but are not in the backup.
 */
export async function recoverPublication(
  journalPath: string,
  liveMemoryRoot: string,
): Promise<RecoveryResult> {
  const journal = readJournal(journalPath);
  if (!journal) {
    return { action: 'noop' };
  }

  const swapStep = journal.steps.find((s) => s.step === 'swap_manifest');
  const manifestSwapped = swapStep?.status === 'done';

  // If manifest was swapped, the filesystem is already committed.
  if (manifestSwapped) {
    return { action: 'finalize', runId: journal.run_id, journal };
  }

  // Check if any step beyond backup_old is done (state: publishing).
  const publishingStarted = journal.steps.some(
    (s) => s.step !== 'backup_old' && s.status === 'done'
  );

  if (!publishingStarted) {
    // State: prepared — no live files touched. Discard staging.
    return { action: 'discard', runId: journal.run_id, journal };
  }

  // State: publishing, manifest not swapped — restore from backup.
  await restoreFromBackup(journal.backup_dir, liveMemoryRoot);
  return { action: 'restore', runId: journal.run_id, journal };
}

/**
 * Restore live memory files from the backup directory.
 *
 * Copies all backup files back to live, then removes any files in live
 * that are NOT in the backup (these were added during the partial publish
 * and need to be rolled back).
 */
async function restoreFromBackup(backupDir: string, liveMemoryRoot: string): Promise<void> {
  // backup_dir is written by preparePublication as an absolute path
  // (path.join(opts.stagingDir, 'backup')), so it is always absolute
  // when read back from the journal during crash recovery.
  if (!fs.existsSync(backupDir)) {
    // No backup to restore from — nothing we can do.
    return;
  }

  // Restore items/ and entities/ from backup.
  for (const sub of ['items', 'entities']) {
    const backupSub = path.join(backupDir, sub);
    const liveSub = path.join(liveMemoryRoot, sub);
    if (fs.existsSync(backupSub)) {
      // Replace live sub with backup copy.
      if (fs.existsSync(liveSub)) {
        await fsp.rm(liveSub, { recursive: true, force: true });
      }
      await copyDirRecursive(backupSub, liveSub);
    } else {
      // No backup for this sub — it didn't exist before. Remove from live.
      if (fs.existsSync(liveSub)) {
        await fsp.rm(liveSub, { recursive: true, force: true });
      }
    }
  }

  // Restore .manifest.json from backup.
  const backupManifest = path.join(backupDir, '.manifest.json');
  if (fs.existsSync(backupManifest)) {
    await fsp.copyFile(backupManifest, path.join(liveMemoryRoot, '.manifest.json'));
  }

  // Remove candidate projections that may have been written to live.
  for (const proj of ['MEMORY.md', 'summary.md']) {
    const liveProj = path.join(liveMemoryRoot, proj);
    if (fs.existsSync(liveProj)) {
      await fsp.unlink(liveProj);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to temp, fsync, rename.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Copy managed memory files (items/ + entities/ + .manifest.json) from
 * src to dest. Skips symlinks and excluded directories.
 */
async function copyManagedFiles(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Only copy managed directories (items, entities). Skip others.
      if (entry.name === 'items' || entry.name === 'entities') {
        await copyDirRecursive(srcPath, destPath);
      }
    } else if (entry.isFile() && entry.name === '.manifest.json') {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Compute a deterministic hash over all files in a directory tree.
 */
async function computeDirectoryHash(dir: string): Promise<string> {
  const crypto = await import('crypto');
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(d: string): Promise<void> {
    const items = await fsp.readdir(d, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(d, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const content = await fsp.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const relPath = path.relative(dir, fullPath).split(path.sep).join('/');
        entries.push({ relPath, fileHash });
      }
    }
  }

  await walk(dir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const payload = entries.map((e) => `${e.relPath}\0${e.fileHash}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}
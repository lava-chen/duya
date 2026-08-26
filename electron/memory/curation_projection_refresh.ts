/**
 * Memory projection refresh (Plan 417 Task H).
 *
 * After every successful single-shot curation, regenerate the read-only
 * projections (MEMORY.md, summary.md, global/<entity>/index.md)
 * from the live canonical files under `global/`. The functions in
 * `curation_projection_live.ts` produce the right content; this module
 * just handles the write side.
 *
 * The Plan 404 staging-based publisher (`curation_publisher.ts`) is
 * intentionally not used here:
 *   1. The single-shot curator already writes to the live memory root
 *      (no staging directory to project from).
 *   2. We don't need atomic swap — the agent reads MEMORY.md only at
 *      prompt-build time, not concurrently with curation.
 *   3. Failure here is non-fatal: the next cycle's refresh fixes it.
 *
 * Atomic per-file: each write goes to `<path>.tmp` then `rename`. The
 * `cleanStagingTmps` helper from `curation_file_writer` sweeps up any
 * orphans left by a crashed refresh.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import {
  generateMemoryMdLive,
  generateIndexMdLive,
} from '../../packages/agent/src/memory-state/curation_projection_live';
import { listEntityDirsSync } from '../../packages/agent/src/memory-state/entity_dirs';
import { cleanStagingTmps } from './curation_file_writer';

// NOTE: summary.md is intentionally NOT a Phase 2 projection anymore.
// Phase 3 (summary_synthesizer) owns it exclusively — it writes the
// semantic digest (profile / rules / memory map / blind spots) with the
// deterministic index as its fallback. Phase 2 only produces MEMORY.md
// and the per-entity index.md files.
const PROJECTION_FILES = [
  { relPath: 'MEMORY.md', generator: generateMemoryMdLive },
] as const;

/**
 * Refresh all read-only projections under `memoryRoot` from the current
 * state of `global/{areas,people}/*.md`. Returns the absolute paths
 * that were touched (for diagnostics + tests).
 *
 * Always sweeps stale `*.tmp` files first, before any write.
 */
export async function refreshProjections(memoryRoot: string): Promise<string[]> {
  // Sweep stragglers from a prior crashed refresh.
  await cleanStagingTmps(memoryRoot).catch(() => 0);

  const touched: string[] = [];

  for (const { relPath, generator } of PROJECTION_FILES) {
    const absolute = path.join(memoryRoot, relPath);
    const content = generator(memoryRoot);
    if (content === '') continue; // generator returned empty, nothing to write
    await atomicWrite(absolute, content);
    touched.push(absolute);
  }

  // Index files per entity directory — the three defaults plus any
  // curator-proposed custom category (dynamic discovery; a hard-coded
  // list here used to strand custom categories without an index).
  for (const entityDir of listEntityDirsSync(memoryRoot)) {
    const content = generateIndexMdLive(memoryRoot, entityDir.name);
    if (content === '') continue;
    const relPath = `${entityDir.relDir}/index.md`;
    const absolute = path.join(memoryRoot, relPath);
    await atomicWrite(absolute, content);
    touched.push(absolute);
  }

  return touched;
}

/**
 * Atomic write: write to `<path>.tmp`, then `rename` over the target.
 * Best-effort cleanup of a stale `tmp` left by a prior crashed write.
 */
async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.tmp`;
  try {
    await fs.unlink(tmpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absolutePath);
}
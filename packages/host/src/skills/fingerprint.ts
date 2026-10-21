/**
 * packages/agent/src/skills/fingerprint.ts
 *
 * Cheap directory fingerprint for the skill snapshot cache (plan 445).
 * Walks a directory collecting `{ relPath, mtimeMs, size }` per file and
 * hashes the manifest — hermes-agent's mtime/size manifest approach. File
 * contents are never read, so this is an order of magnitude cheaper than
 * `computeDirHash` while still reacting to any create/modify/delete.
 */

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { shouldSkipScanDir } from './scanFilter.js';

interface ManifestEntry {
  /** Path relative to the scanned root, POSIX separators for stability. */
  relPath: string;
  mtimeMs: number;
  size: number;
}

async function walk(
  dirPath: string,
  prefix: string,
  out: ManifestEntry[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    // Unreadable subtree counts as content change vs. any previous walk.
    out.push({ relPath: `${prefix}<unreadable>`, mtimeMs: 0, size: 0 });
    return;
  }

  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    if (shouldSkipScanDir(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      // Symlinks can point anywhere; record only their existence so the
      // fingerprint stays stable without following the target.
      out.push({ relPath: `${relPath}<symlink>`, mtimeMs: 0, size: 0 });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(fullPath, relPath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fsp.stat(fullPath);
      out.push({ relPath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      out.push({ relPath: `${relPath}<unreadable>`, mtimeMs: 0, size: 0 });
    }
  }
}

/**
 * Fingerprint a directory tree, or null when the root itself does not
 * exist. Any change to the set of files, their sizes, or mtimes yields a
 * different value; identical trees yield identical values across calls
 * and processes (stable sort + stable serialization).
 */
export async function fingerprintDir(dirPath: string): Promise<string | null> {
  let rootStat;
  try {
    rootStat = await fsp.stat(dirPath);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const manifest: ManifestEntry[] = [];
  await walk(dirPath, '', manifest);

  const hash = createHash('sha256');
  for (const m of manifest) {
    hash.update(`${m.relPath}\u0000${m.mtimeMs}\u0000${m.size}\u0001`);
  }
  return hash.digest('hex');
}

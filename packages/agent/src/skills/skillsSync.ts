/**
 * Skills Sync - Manifest-based seeding and updating of bundled skills.
 *
 * Copies bundled skills from the package's skills/ directory into ~/.duya/skills/
 * and uses a manifest to track which skills have been synced and their origin hash.
 *
 * Manifest format (JSON):
 * {
 *   "version": 2,
 *   "skills": {
 *     "skill_name": {
 *       "hash": "origin_hash",
 *       "syncedAt": "2024-01-15T10:30:00Z"
 *     }
 *   }
 * }
 *
 * Update logic:
 * - NEW skills (not in manifest): copied to user dir, recorded.
 * - EXISTING skills (in manifest, present in user dir):
 *     * If user copy matches origin hash: user hasn't modified it -> safe to
 *       update from bundled if bundled changed. New origin hash recorded.
 *     * If user copy differs from origin hash: user customized it -> SKIP.
 * - DELETED by user (in manifest, absent from user dir): respected, not re-added.
 * - REMOVED from bundled (in manifest, gone from repo): cleaned from manifest.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getBundledSkillsDir } from './loader.js';

const MANIFEST_FILENAME = '.bundled_manifest.json';
const MANIFEST_VERSION = 2;

function getUserSkillsDir(): string {
  return path.join(os.homedir(), '.duya', 'skills');
}

function getManifestPath(): string {
  return path.join(getUserSkillsDir(), MANIFEST_FILENAME);
}

function getBundledDir(): string {
  return getBundledSkillsDir();
}

async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

async function computeDirHash(dirPath: string): Promise<string> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const hashes: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isFile()) {
      const hash = await computeFileHash(entryPath);
      hashes.push(`${entry.name}:${hash}`);
    } else if (entry.isDirectory()) {
      const dirHash = await computeDirHash(entryPath);
      hashes.push(`${entry.name}/:${dirHash}`);
    }
  }

  return crypto.createHash('md5').update(hashes.join('|')).digest('hex');
}

/**
 * Manifest entry for a synced skill
 */
interface ManifestEntry {
  hash: string;
  syncedAt: string;
}

/**
 * Manifest structure
 */
interface Manifest {
  version: number;
  skills: Record<string, ManifestEntry>;
}

async function readManifest(): Promise<Manifest> {
  const manifestPath = getManifestPath();

  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as Manifest;
    if (parsed.version === MANIFEST_VERSION && parsed.skills) {
      return parsed;
    }
    // Version mismatch or invalid format, start fresh
  } catch {
    // Manifest doesn't exist yet or invalid JSON
  }

  return { version: MANIFEST_VERSION, skills: {} };
}

async function writeManifest(manifest: Manifest): Promise<void> {
  const manifestPath = getManifestPath();
  const dir = path.dirname(manifestPath);

  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${manifestPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmpPath, manifestPath);
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function removeDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
}

export interface SyncResult {
  added: string[];
  updated: string[];
  skipped: string[];
  removed: string[];
}

/**
 * Sync bundled skills to user skills directory.
 * Returns information about what was changed.
 */
export async function syncBundledSkills(): Promise<SyncResult> {
  const bundledDir = getBundledDir();
  const userDir = getUserSkillsDir();
  const manifest = await readManifest();

  const result: SyncResult = {
    added: [],
    updated: [],
    skipped: [],
    removed: [],
  };

  if (!(await dirExists(bundledDir))) {
    console.warn('[SkillsSync] Bundled skills directory not found:', bundledDir);
    return result;
  }

  await fs.mkdir(userDir, { recursive: true });

  const bundledEntries = await fs.readdir(bundledDir, { withFileTypes: true });
  const bundledSkillNames = new Set<string>();

  for (const entry of bundledEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    bundledSkillNames.add(entry.name);
    const skillSrc = path.join(bundledDir, entry.name);
    const skillDest = path.join(userDir, entry.name);

    const manifestEntry = manifest.skills[entry.name];

    if (!manifestEntry) {
      // NEW skill: not in manifest
      await copyDir(skillSrc, skillDest);
      const hash = await computeDirHash(skillSrc);
      manifest.skills[entry.name] = {
        hash,
        syncedAt: new Date().toISOString(),
      };
      result.added.push(entry.name);
    } else {
      const existingInUser = await dirExists(skillDest);

      if (existingInUser) {
        const userHash = await computeDirHash(skillDest);
        const bundledHash = manifestEntry.hash;

        if (userHash === bundledHash) {
          // User hasn't modified the skill
          const newBundledHash = await computeDirHash(skillSrc);
          if (newBundledHash !== bundledHash) {
            // Bundled skill has been updated
            await removeDir(skillDest);
            await copyDir(skillSrc, skillDest);
            manifest.skills[entry.name] = {
              hash: newBundledHash,
              syncedAt: new Date().toISOString(),
            };
            result.updated.push(entry.name);
          } else {
            result.skipped.push(entry.name);
          }
        } else {
          // User has customized the skill, skip update
          result.skipped.push(entry.name);
        }
      } else {
        // Skill was deleted by user but is in manifest, re-add it
        await copyDir(skillSrc, skillDest);
        const hash = await computeDirHash(skillSrc);
        manifest.skills[entry.name] = {
          hash,
          syncedAt: new Date().toISOString(),
        };
        result.added.push(entry.name);
      }
    }
  }

  // Clean up skills removed from bundled
  const bundledSet = new Set(bundledEntries.filter(e => e.isDirectory()).map(e => e.name));
  for (const skillName of Object.keys(manifest.skills)) {
    if (!bundledSet.has(skillName)) {
      delete manifest.skills[skillName];
      result.removed.push(skillName);
    }
  }

  await writeManifest(manifest);

  return result;
}

/**
 * Check if user skills directory needs syncing.
 */
export async function needsSync(): Promise<boolean> {
  const userDir = getUserSkillsDir();
  const manifestPath = getManifestPath();

  if (!(await dirExists(userDir))) {
    return true;
  }

  try {
    await fs.access(manifestPath);
    return false;
  } catch {
    return true;
  }
}

/**
 * Get the user skills directory path.
 */
export function getUserSkillsDirectory(): string {
  return getUserSkillsDir();
}

/**
 * Get the bundled skills directory path.
 */
export function getBundledSkillsDirectory(): string {
  return getBundledDir();
}

/**
 * Check if a skill in the user directory was originally synced from bundled.
 * Returns true if the skill name exists in the manifest.
 */
export async function isBundledSkill(skillName: string): Promise<boolean> {
  const manifest = await readManifest();
  return skillName in manifest.skills;
}

/**
 * List all skill names that were originally synced from bundled.
 */
export async function listBundledSkillNames(): Promise<string[]> {
  const manifest = await readManifest();
  return Object.keys(manifest.skills);
}

/**
 * Get detailed info about a bundled skill from manifest.
 */
export async function getBundledSkillInfo(skillName: string): Promise<{ hash: string; syncedAt: string } | null> {
  const manifest = await readManifest();
  const entry = manifest.skills[skillName];
  return entry ? { hash: entry.hash, syncedAt: entry.syncedAt } : null;
}

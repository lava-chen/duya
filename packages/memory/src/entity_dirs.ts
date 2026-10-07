/**
 * Entity directory discovery (shared source of truth).
 *
 * The Phase 2 memory tree lives under `<memoryRoot>/global/<category>/`,
 * where `<category>` is one of the three default buckets (`areas`,
 * `people`, `preferences`) or a curator-proposed custom category created
 * via the curation protocol's `new_categories` action.
 *
 * Historically every downstream consumer hard-coded the three default
 * directories:
 *   - MEMORY.md projection (`curation_projection_live.ts`)
 *   - per-directory index generation (`curation_projection_refresh.ts`)
 *   - summary synthesis input + canonical hash (`summary_synthesizer.ts`)
 *   - curator panorama / next-cycle visibility (`curation_single_shot.ts`)
 *
 * The consequence was that a successfully-created custom category became
 * invisible to all of them: it never appeared in MEMORY.md, never fed the
 * summary digest, and — worst — the next curation cycle's panorama did not
 * list it, so the curator could not see the dimension was already covered
 * and would re-propose or misfile content indefinitely.
 *
 * This module is the single enumeration point. Every consumer MUST derive
 * its entity directory list from here instead of a local constant.
 *
 * Grammar note: a valid category directory name matches
 * `^[a-z][a-z0-9-]{1,20}$` — the exact shape accepted by the curation
 * protocol's `NewCategorySchema` and by the custom branch of
 * `AREA_PATH_RE`. Directories outside this grammar under `global/` are
 * NOT entity categories (tooling, user files) and are ignored.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** One discovered entity bucket under `global/`. */
export interface EntityDir {
  /** Directory name under `global/` (e.g. `areas`, `lessons`). */
  name: string;
  /** Canonical-key label (e.g. `area`, `person`, `lessons`). */
  type: string;
  /** memoryRoot-relative path with forward slashes (e.g. `global/areas`). */
  relDir: string;
}

/** The three seeded buckets, in their canonical display order. */
export const DEFAULT_ENTITY_TYPES = ['area', 'person', 'preference'] as const;

const DEFAULT_ENTITY_DIR_NAMES = ['areas', 'people', 'preferences'] as const;

/** Category-name grammar shared with `NewCategorySchema` / `AREA_PATH_RE`. */
const ENTITY_DIR_NAME_RE = /^[a-z][a-z0-9-]{1,20}$/;

/** Map a `global/` directory name to its canonical-key label. */
export function dirNameToEntityType(name: string): string {
  switch (name) {
    case 'areas': return 'area';
    case 'people': return 'person';
    case 'preferences': return 'preference';
    default: return name;
  }
}

/** True when `name` is a valid entity-category directory name. */
export function isValidEntityDirName(name: string): boolean {
  return ENTITY_DIR_NAME_RE.test(name);
}

function buildEntityDir(name: string): EntityDir {
  return { name, type: dirNameToEntityType(name), relDir: `global/${name}` };
}

function mergeWithDefaults(discoveredNames: string[]): EntityDir[] {
  const seen = new Set<string>();
  const out: EntityDir[] = [];
  // Defaults first, in canonical order, whether or not they exist on disk
  // yet (first-run bootstrap must still render/index them).
  for (const name of DEFAULT_ENTITY_DIR_NAMES) {
    out.push(buildEntityDir(name));
    seen.add(name);
  }
  // Then discovered custom categories, alphabetically for stable output.
  for (const name of [...discoveredNames].sort()) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(buildEntityDir(name));
  }
  return out;
}

/**
 * Synchronous enumeration of every entity category under
 * `<memoryRoot>/global/`.
 *
 * Always includes the three defaults (even before first write); appends
 * discovered custom categories whose name matches the category grammar
 * and which exist on disk. Non-directories and grammar-violating names
 * are ignored.
 */
export function listEntityDirsSync(memoryRoot: string): EntityDir[] {
  const globalDir = path.join(memoryRoot, 'global');
  const discovered: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(globalDir, { withFileTypes: true });
  } catch {
    return mergeWithDefaults([]);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidEntityDirName(entry.name)) continue;
    discovered.push(entry.name);
  }
  return mergeWithDefaults(discovered);
}

/**
 * Async variant of {@link listEntityDirsSync} for promise-based callers.
 * Same discovery rules, same ordering.
 */
export async function listEntityDirs(memoryRoot: string): Promise<EntityDir[]> {
  const globalDir = path.join(memoryRoot, 'global');
  const discovered: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(globalDir, { withFileTypes: true });
  } catch {
    return mergeWithDefaults([]);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidEntityDirName(entry.name)) continue;
    discovered.push(entry.name);
  }
  return mergeWithDefaults(discovered);
}

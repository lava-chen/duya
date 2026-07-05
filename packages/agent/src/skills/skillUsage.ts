/**
 * Skill usage telemetry + lifecycle state machine.
 *
 * Sidecar JSON file at `~/.duya/skills/.usage.json` tracks per-skill
 * usage stats and lifecycle state (active / stale / archived).
 *
 * Inspired by hermes-agent's `tools/skill_usage.py`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const SKILLS_DIR = path.join(homedir(), '.duya', 'skills');
const USAGE_FILE = path.join(SKILLS_DIR, '.usage.json');

/** Days of inactivity before a skill is marked stale. */
const STALE_DAYS = 30;
/** Days of inactivity before a skill is archived. */
const ARCHIVE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Skills that must never be archived or consolidated. */
export const PROTECTED_SKILLS = new Set<string>([
  // Add built-in skill names that should never be touched by Curator
]);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type SkillState = 'active' | 'stale' | 'archived';
export type SkillProvenance = 'bundled' | 'agent' | 'user';

export interface SkillUsageEntry {
  /** Who created this skill. 'bundled' = shipped with DUYA, 'agent' = self-improver, 'user' = manual. */
  created_by: SkillProvenance;
  /** How many times the skill was invoked (Skill tool loaded it). */
  use_count: number;
  /** How many times the skill was viewed/listed. */
  view_count: number;
  /** ISO timestamp of last invocation. */
  last_used_at: string | null;
  /** ISO timestamp of last view. */
  last_viewed_at: string | null;
  /** How many times the skill was patched/edited. */
  patch_count: number;
  /** ISO timestamp of last patch. */
  last_patched_at: string | null;
  /** ISO timestamp of creation. */
  created_at: string;
  /** Lifecycle state. */
  state: SkillState;
  /** ISO timestamp of archiving (if archived). */
  archived_at: string | null;
  /** Whether the user has pinned this skill (prevents auto-archive). */
  pinned: boolean;
}

export type UsageDB = Record<string, SkillUsageEntry>;

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

/** Format a Date as ISO string. */
function iso(d: Date = new Date()): string {
  return d.toISOString();
}

/** Parse an ISO string into a timestamp number; returns 0 if invalid/null. */
function parseTs(s: string | null): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

// ----------------------------------------------------------------------------
// Load / Save
// ----------------------------------------------------------------------------

let cachedDb: UsageDB | null = null;
let writeInProgress: Promise<void> = Promise.resolve();

/**
 * Load the usage DB from disk. Cached in memory after first load.
 * Returns an empty object if the file does not exist.
 */
export async function loadUsageDb(): Promise<UsageDB> {
  if (cachedDb) return cachedDb;
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf-8');
    cachedDb = JSON.parse(raw) as UsageDB;
  } catch {
    cachedDb = {};
  }
  return cachedDb;
}

/**
 * Persist the usage DB to disk atomically. Fire-and-forget safe.
 */
export async function saveUsageDb(db: UsageDB): Promise<void> {
  cachedDb = db;
  // Chain writes to avoid race conditions
  writeInProgress = writeInProgress.then(async () => {
    try {
      await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
      const tmp = `${USAGE_FILE}.tmp.${Date.now()}`;
      await fs.writeFile(tmp, JSON.stringify(db, null, 2), 'utf-8');
      await fs.rename(tmp, USAGE_FILE);
    } catch {
      // Best-effort — usage telemetry is non-critical
    }
  });
  await writeInProgress;
}

/**
 * Get a single skill's usage entry, creating a default if missing.
 */
export async function getUsageEntry(skillName: string): Promise<SkillUsageEntry> {
  const db = await loadUsageDb();
  if (db[skillName]) return db[skillName];
  return {
    created_by: 'user',
    use_count: 0,
    view_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    patch_count: 0,
    last_patched_at: null,
    created_at: iso(),
    state: 'active',
    archived_at: null,
    pinned: false,
  };
}

/**
 * Update a skill's usage entry by merging partial fields.
 */
export async function updateUsageEntry(
  skillName: string,
  patch: Partial<SkillUsageEntry>
): Promise<void> {
  const db = await loadUsageDb();
  const current = db[skillName] ?? await getUsageEntry(skillName);
  db[skillName] = { ...current, ...patch };
  await saveUsageDb(db);
}

// ----------------------------------------------------------------------------
// Telemetry: record skill invocations
// ----------------------------------------------------------------------------

/**
 * Record that a skill was invoked (Skill tool loaded it).
 */
export async function recordSkillUse(skillName: string): Promise<void> {
  const entry = await getUsageEntry(skillName);
  await updateUsageEntry(skillName, {
    use_count: entry.use_count + 1,
    last_used_at: iso(),
    // If skill was stale and gets used, reactivate it
    state: entry.state === 'stale' ? 'active' : entry.state,
    archived_at: null,
  });
}

/**
 * Record that a skill was viewed (listed in metadata / viewed details).
 */
export async function recordSkillView(skillName: string): Promise<void> {
  const entry = await getUsageEntry(skillName);
  await updateUsageEntry(skillName, {
    view_count: entry.view_count + 1,
    last_viewed_at: iso(),
  });
}

/**
 * Record that a skill was patched or edited.
 */
export async function recordSkillPatch(skillName: string, provenance?: SkillProvenance): Promise<void> {
  const entry = await getUsageEntry(skillName);
  await updateUsageEntry(skillName, {
    patch_count: entry.patch_count + 1,
    last_patched_at: iso(),
    // A patch reactivates the skill
    state: 'active',
    archived_at: null,
    ...(provenance ? { created_by: provenance } : {}),
  });
}

/**
 * Record that a new skill was created.
 */
export async function recordSkillCreate(
  skillName: string,
  provenance: SkillProvenance = 'user'
): Promise<void> {
  await updateUsageEntry(skillName, {
    created_by: provenance,
    created_at: iso(),
    state: 'active',
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    archived_at: null,
    pinned: false,
  });
}

/**
 * Record that a skill was deleted (remove its usage entry).
 */
export async function recordSkillDelete(skillName: string): Promise<void> {
  const db = await loadUsageDb();
  delete db[skillName];
  await saveUsageDb(db);
}

// ----------------------------------------------------------------------------
// Pin management
// ----------------------------------------------------------------------------

/**
 * Pin a skill so it is never auto-archived or consolidated.
 */
export async function pinSkill(skillName: string): Promise<void> {
  await updateUsageEntry(skillName, { pinned: true });
}

/**
 * Unpin a skill.
 */
export async function unpinSkill(skillName: string): Promise<void> {
  await updateUsageEntry(skillName, { pinned: false });
}

/**
 * Check if a skill is pinned.
 */
export async function isPinned(skillName: string): Promise<boolean> {
  const entry = await getUsageEntry(skillName);
  return entry.pinned;
}

// ----------------------------------------------------------------------------
// Provenance
// ----------------------------------------------------------------------------

/**
 * Get the provenance of a skill (who created it).
 */
export async function getProvenance(skillName: string): Promise<SkillProvenance> {
  const entry = await getUsageEntry(skillName);
  return entry.created_by;
}

/**
 * Mark a skill as created by the self-improvement agent.
 */
export async function markAgentCreated(skillName: string): Promise<void> {
  await updateUsageEntry(skillName, { created_by: 'agent' });
}

/**
 * Check if a skill was created by the self-improvement agent
 * (and thus is eligible for Curator management).
 */
export async function isAgentCreated(skillName: string): Promise<boolean> {
  const entry = await getUsageEntry(skillName);
  return entry.created_by === 'agent';
}

// ----------------------------------------------------------------------------
// Lifecycle state machine
// ----------------------------------------------------------------------------

/**
 * Apply automatic lifecycle transitions based on inactivity.
 * - active → stale: last_used_at older than STALE_DAYS
 * - stale → archived: last_used_at older than ARCHIVE_DAYS
 * Pinned skills and protected skills skip all transitions.
 *
 * Returns a summary of transitions applied.
 */
export async function applyAutomaticTransitions(): Promise<{
  stale: string[];
  archived: string[];
}> {
  const db = await loadUsageDb();
  const now = Date.now();
  const stale: string[] = [];
  const archived: string[] = [];

  for (const [name, entry] of Object.entries(db)) {
    // Skip pinned and protected skills
    if (entry.pinned) continue;
    if (PROTECTED_SKILLS.has(name)) continue;

    // Skip already-archived skills
    if (entry.state === 'archived') continue;

    const lastUsed = parseTs(entry.last_used_at);
    // Fall back to created_at if never used
    const lastActivity = lastUsed || parseTs(entry.created_at);
    const idleDays = (now - lastActivity) / DAY_MS;

    if (entry.state === 'active' && idleDays >= STALE_DAYS) {
      entry.state = 'stale';
      stale.push(name);
    } else if (entry.state === 'stale' && idleDays >= ARCHIVE_DAYS) {
      entry.state = 'archived';
      entry.archived_at = iso();
      archived.push(name);
    } else if (entry.state === 'active' && idleDays >= ARCHIVE_DAYS) {
      // Active but very old — skip stale and archive directly
      entry.state = 'archived';
      entry.archived_at = iso();
      archived.push(name);
    }
  }

  await saveUsageDb(db);
  return { stale, archived };
}

/**
 * Get all skills in a given state.
 */
export async function getSkillsByState(state: SkillState): Promise<string[]> {
  const db = await loadUsageDb();
  return Object.entries(db)
    .filter(([, entry]) => entry.state === state)
    .map(([name]) => name);
}

/**
 * Get usage stats for all skills, sorted by use_count descending.
 */
export async function getUsageStats(): Promise<Array<{ name: string } & SkillUsageEntry>> {
  const db = await loadUsageDb();
  return Object.entries(db)
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.use_count - a.use_count);
}

/**
 * Check if a skill is eligible for Curator management
 * (agent-created and not pinned and not protected).
 */
export async function isCuratorEligible(skillName: string): Promise<boolean> {
  const entry = await getUsageEntry(skillName);
  if (entry.pinned) return false;
  if (PROTECTED_SKILLS.has(skillName)) return false;
  return entry.created_by === 'agent';
}

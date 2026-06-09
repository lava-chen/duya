/**
 * SelfImproverState - Persistent storage for SelfImprover counters
 *
 * SelfImprover needs to remember how many turns have elapsed since
 * the last successful skill creation across multiple
 * `duyaAgent.streamChat()` calls. The agent instance is short-lived
 * (one per user query), so without persistence the counter resets
 * to 0 on every query, making the "every N turns" trigger
 * effectively "every N turns within a single query" — which is too
 * rare in practice.
 *
 * Storage: a single JSON file at
 *   ~/.duya/self-improver-state.json
 * with shape:
 *   {
 *     "itersSinceSkill": 0,
 *     "toolCallsSinceSkill": 0,
 *     "lastResetAt": <epoch ms>,
 *     "lastReviewAt": <epoch ms | null>
 *   }
 *
 * Operations are atomic-write via temp file + rename (same pattern
 * as `atomicWriteText` in SkillDraftManager).
 *
 * Failure mode: any I/O error degrades gracefully — the caller
 * treats the file as "not present" and starts from 0. We never
 * throw from this module; the worst case is "counter doesn't
 * persist", which is the same as today's behavior.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const STATE_DIR = path.join(homedir(), '.duya');
const STATE_FILE = path.join(STATE_DIR, 'self-improver-state.json');

export interface SelfImproverPersistedState {
  itersSinceSkill: number;
  toolCallsSinceSkill: number;
  lastResetAt: number;
  lastReviewAt: number | null;
}

const DEFAULT_STATE: SelfImproverPersistedState = {
  itersSinceSkill: 0,
  toolCallsSinceSkill: 0,
  lastResetAt: 0,
  lastReviewAt: null,
};

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const tempPath = path.join(dir, `.${name}.tmp.${Date.now()}`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Load the persisted counter state. Returns the default state (all
 * zeros) on any I/O or parse error — never throws.
 */
export async function loadSelfImproverState(): Promise<SelfImproverPersistedState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SelfImproverPersistedState>;
    // Validate shape; fall back to defaults for missing/malformed fields.
    return {
      itersSinceSkill:
        typeof parsed.itersSinceSkill === 'number' && parsed.itersSinceSkill >= 0
          ? Math.floor(parsed.itersSinceSkill)
          : 0,
      toolCallsSinceSkill:
        typeof parsed.toolCallsSinceSkill === 'number' && parsed.toolCallsSinceSkill >= 0
          ? Math.floor(parsed.toolCallsSinceSkill)
          : 0,
      lastResetAt:
        typeof parsed.lastResetAt === 'number' ? parsed.lastResetAt : 0,
      lastReviewAt:
        typeof parsed.lastReviewAt === 'number' ? parsed.lastReviewAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Persist the current counter state. Failures are logged but never
 * thrown — persistence is best-effort.
 */
export async function saveSelfImproverState(
  state: SelfImproverPersistedState,
): Promise<void> {
  try {
    await atomicWriteJson(STATE_FILE, state);
  } catch (err) {
    // Best-effort: log to stderr but don't crash. Persistence is
    // an optimization, not a correctness requirement.
    console.warn(
      `[SelfImprover] Failed to persist state to ${STATE_FILE}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Reset the persisted state to defaults (used after a successful
 * skill review or when skill_manage is invoked).
 */
export async function clearSelfImproverState(): Promise<void> {
  try {
    await atomicWriteJson(STATE_FILE, { ...DEFAULT_STATE, lastResetAt: Date.now() });
  } catch {
    // Best-effort
  }
}

/**
 * Return the storage file path (useful for diagnostics / tests).
 */
export function getSelfImproverStatePath(): string {
  return STATE_FILE;
}

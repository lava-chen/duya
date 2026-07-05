/**
 * Skill Curator — periodic umbrella consolidation agent.
 *
 * Inspired by hermes-agent's `agent/curator.py`.
 *
 * Unlike the Creator-Evaluator loop (which runs per-turn and creates
 * new skills), the Curator runs on a slow cadence (default 7 days)
 * and performs cross-skill consolidation:
 *
 *   1. Apply automatic lifecycle transitions (active → stale → archived)
 *   2. Identify prefix clusters of agent-created skills
 *   3. For each cluster, decide: merge into existing umbrella, create
 *      new umbrella, or demote narrow skills to support files
 *   4. Archive consolidated/pruned skills (recoverable, never delete)
 *
 * The Curator never touches bundled, pinned, or protected skills.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { getSkillRegistry } from '../skills/registry.js';
import type { SkillMetadata } from '../skills/types.js';
import {
  applyAutomaticTransitions,
  isCuratorEligible,
  getUsageStats,
  loadUsageDb,
  saveUsageDb,
  type SkillUsageEntry,
} from '../skills/skillUsage.js';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const SKILLS_DIR = path.join(homedir(), '.duya', 'skills');
const ARCHIVE_DIR = path.join(SKILLS_DIR, '.archive');
const CURATOR_STATE_FILE = path.join(SKILLS_DIR, '.curator-state.json');

/** Minimum idle interval between Curator runs (7 days). */
const DEFAULT_CURATOR_INTERVAL_HOURS = 7 * 24;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CuratorState {
  last_run_at: string | null;
  last_run_duration_seconds: number;
  last_run_summary: string;
  paused: boolean;
  run_count: number;
}

export interface CuratorResult {
  autoTransitions: { stale: string[]; archived: string[] };
  clusters: SkillCluster[];
  consolidated: ConsolidationRecord[];
  pruned: PruningRecord[];
  summary: string;
  duration: number;
}

export interface SkillCluster {
  prefix: string;
  members: Array<{ name: string; category?: string; description: string; use_count: number }>;
}

export interface ConsolidationRecord {
  from: string;
  into: string;
  reason: string;
}

export interface PruningRecord {
  name: string;
  reason: string;
}

// ----------------------------------------------------------------------------
// Curator State Persistence
// ----------------------------------------------------------------------------

async function loadCuratorState(): Promise<CuratorState> {
  try {
    const raw = await fs.readFile(CURATOR_STATE_FILE, 'utf-8');
    return JSON.parse(raw) as CuratorState;
  } catch {
    return {
      last_run_at: null,
      last_run_duration_seconds: 0,
      last_run_summary: '',
      paused: false,
      run_count: 0,
    };
  }
}

async function saveCuratorState(state: CuratorState): Promise<void> {
  try {
    const tmp = `${CURATOR_STATE_FILE}.tmp.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tmp, CURATOR_STATE_FILE);
  } catch {
    // Best-effort
  }
}

// ----------------------------------------------------------------------------
// Cluster Detection
// ----------------------------------------------------------------------------

/**
 * Identify groups of skills that share a common prefix (first word
 * before `-` or domain keyword). Only agent-created skills are
 * considered for consolidation.
 *
 * Example clusters: `electron-e2e*`, `lazy-fade*`, `static-photo*`
 */
function detectClusters(
  skills: Array<SkillMetadata & { usage?: SkillUsageEntry }>
): SkillCluster[] {
  const groups: Map<string, SkillCluster> = new Map();

  for (const skill of skills) {
    // Extract prefix: first segment before `-` or `_`
    const parts = skill.name.split(/[-_]/);
    if (parts.length < 2) continue; // Single-word names can't form clusters

    const prefix = parts[0];
    if (prefix.length < 3) continue; // Skip very short prefixes

    if (!groups.has(prefix)) {
      groups.set(prefix, { prefix, members: [] });
    }
    groups.get(prefix)!.members.push({
      name: skill.name,
      category: skill.category,
      description: skill.description || '',
      use_count: skill.usage?.use_count ?? 0,
    });
  }

  // Only return clusters with 2+ members
  return Array.from(groups.values())
    .filter(g => g.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length);
}

// ----------------------------------------------------------------------------
// Archive (never delete — always recoverable)
// ----------------------------------------------------------------------------

/**
 * Move a skill directory to the archive. The skill can be restored
 * by moving it back.
 */
async function archiveSkill(skillName: string): Promise<boolean> {
  try {
    // Find the skill directory
    const registry = getSkillRegistry();
    const skill = registry.get(skillName);
    if (!skill) return false;

    // Find the actual directory on disk
    const possiblePaths = [
      path.join(SKILLS_DIR, skill.category || 'general', skillName),
      path.join(SKILLS_DIR, skillName),
    ];

    let skillDir: string | null = null;
    for (const p of possiblePaths) {
      try {
        await fs.access(p);
        skillDir = p;
        break;
      } catch {
        // Not here
      }
    }

    if (!skillDir) return false;

    // Create archive directory
    const archivePath = path.join(ARCHIVE_DIR, skillName);
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });

    // Move to archive
    await fs.rename(skillDir, archivePath);

    // Update usage state
    const db = await loadUsageDb();
    if (db[skillName]) {
      db[skillName].state = 'archived';
      db[skillName].archived_at = new Date().toISOString();
      await saveUsageDb(db);
    }

    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Curator Agent Prompt
// ----------------------------------------------------------------------------

/**
 * The Curator prompt for cross-skill consolidation.
 *
 * This prompt is sent to a forked agent that has access to skill_manage
 * and terminal tools. The agent reviews the cluster list and decides
 * consolidation actions.
 */
export const CURATOR_REVIEW_PROMPT = `You are a skill curator. Your job is to consolidate overlapping skills into clean, class-level umbrella skills.

## Core Principle

The goal of the skill collection is a LIBRARY OF CLASS-LEVEL INSTRUCTIONS. A collection of hundreds of narrow skills where each captures one session's specific bug is a FAILURE — not a feature.

## What You Will See

You will be given a list of skill clusters — groups of skills that share a common prefix and likely cover similar workflows. For each cluster, you must decide:

1. **MERGE INTO EXISTING UMBRELLA**: If one skill in the cluster is broad enough to serve as an umbrella, patch it to absorb the others' unique content, then archive the absorbed skills.

2. **CREATE A NEW UMBRELLA**: If no existing skill is broad enough, create a new class-level skill that subsumes the narrow ones, then archive them.

3. **DEMOTE TO SUPPORT FILES**: If a narrow skill has valuable but session-specific content (e.g., a specific debug script), move that content into the umbrella skill's \`references/\` directory, then archive the narrow skill.

## Rules

1. NEVER delete a skill — always archive with skill_manage(action='delete') which moves it to .archive/
2. NEVER touch pinned skills or bundled skills
3. Do NOT use usage counters as a reason to skip consolidation — counters are new and often zero. Judge overlap on CONTENT.
4. Do NOT reject consolidation on the grounds that "each skill has a distinct trigger." Pairwise distinctness is the WRONG bar. The right bar is: "would a human maintainer write this as N separate skills, or as one skill with N labeled subsections?"
5. Keep umbrella skills under 300 lines. If the merged content would exceed that, split into references/ files.
6. After consolidation, provide a structured summary:

\`\`\`yaml
consolidations:
  - from: <old-skill-name>
    into: <umbrella-skill-name>
    reason: <one short sentence>
prunings:
  - name: <skill-name>
    reason: <one short sentence>
\`\`\`

## Quality Bar

Only consolidate when the skills genuinely overlap in workflow. If two skills share a prefix but serve completely different purposes (e.g., "twitter-extract" and "twitter-post" are different enough), leave them separate.
`;

// ----------------------------------------------------------------------------
// Main Curator Logic
// ----------------------------------------------------------------------------

export class SkillCurator {
  private intervalHours: number;

  constructor(intervalHours: number = DEFAULT_CURATOR_INTERVAL_HOURS) {
    this.intervalHours = intervalHours;
  }

  /**
   * Check if enough time has passed since the last Curator run.
   */
  async shouldRun(): Promise<boolean> {
    const state = await loadCuratorState();
    if (state.paused) return false;
    if (!state.last_run_at) return true;

    const lastRun = Date.parse(state.last_run_at);
    if (Number.isNaN(lastRun)) return true;

    const elapsed = (Date.now() - lastRun) / (1000 * 60 * 60); // hours
    return elapsed >= this.intervalHours;
  }

  /**
   * Run the Curator. This is a two-phase process:
   *   1. Automatic state transitions (no LLM needed)
   *   2. LLM-driven cluster consolidation (forked agent)
   *
   * The LLM phase is optional — if no clusters are detected, only
   * automatic transitions are applied.
   */
  async run(): Promise<CuratorResult> {
    const startTime = Date.now();

    // Phase 1: Automatic lifecycle transitions
    const autoTransitions = await applyAutomaticTransitions();

    // Phase 2: Cluster detection
    const registry = getSkillRegistry();
    const allSkills = registry.listMetadata();

    // Filter to curator-eligible skills only
    const eligibleSkills: typeof allSkills = [];
    for (const skill of allSkills) {
      const eligible = await isCuratorEligible(skill.name);
      if (eligible) eligibleSkills.push(skill);
    }

    // Enrich with usage stats
    const usageStats = await getUsageStats();
    const usageMap = new Map(usageStats.map(s => [s.name, s]));
    const enrichedSkills = eligibleSkills.map(s => ({
      ...s,
      usage: usageMap.get(s.name),
    }));

    const clusters = detectClusters(enrichedSkills);

    // Phase 3: LLM-driven consolidation (if clusters exist)
    const consolidated: ConsolidationRecord[] = [];
    const pruned: PruningRecord[] = [];

    if (clusters.length > 0) {
      // The LLM consolidation would be done by a forked agent.
      // For now, we auto-archive skills that are in clusters AND
      // have zero usage — they are likely stale duplicates.
      // The full LLM-driven consolidation will be triggered separately.
      for (const cluster of clusters) {
        // If cluster has 3+ members and all have 0 usage, archive
        // all but the first (which becomes the umbrella candidate)
        const allUnused = cluster.members.every(m => m.use_count === 0);
        if (allUnused && cluster.members.length >= 3) {
          // Archive all but the first member
          for (let i = 1; i < cluster.members.length; i++) {
            const archived = await archiveSkill(cluster.members[i].name);
            if (archived) {
              pruned.push({
                name: cluster.members[i].name,
                reason: `Auto-archived: cluster '${cluster.prefix}' has ${cluster.members.length} unused duplicates`,
              });
            }
          }
        }
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    const summary = this.buildSummary(autoTransitions, clusters, consolidated, pruned);

    // Persist state
    const state = await loadCuratorState();
    state.last_run_at = new Date().toISOString();
    state.last_run_duration_seconds = duration;
    state.last_run_summary = summary;
    state.run_count++;
    await saveCuratorState(state);

    return {
      autoTransitions,
      clusters,
      consolidated,
      pruned,
      summary,
      duration,
    };
  }

  private buildSummary(
    auto: { stale: string[]; archived: string[] },
    clusters: SkillCluster[],
    consolidated: ConsolidationRecord[],
    pruned: PruningRecord[]
  ): string {
    const parts: string[] = [];
    if (auto.stale.length > 0) parts.push(`auto: ${auto.stale.length} marked stale`);
    if (auto.archived.length > 0) parts.push(`auto: ${auto.archived.length} archived`);
    if (clusters.length > 0) parts.push(`detected ${clusters.length} cluster(s)`);
    if (consolidated.length > 0) parts.push(`consolidated ${consolidated.length} skill(s)`);
    if (pruned.length > 0) parts.push(`pruned ${pruned.length} skill(s)`);
    return parts.join('; ') || 'no actions taken';
  }

  /**
   * Pause the Curator (stop it from running).
   */
  async pause(): Promise<void> {
    const state = await loadCuratorState();
    state.paused = true;
    await saveCuratorState(state);
  }

  /**
   * Resume the Curator.
   */
  async resume(): Promise<void> {
    const state = await loadCuratorState();
    state.paused = false;
    await saveCuratorState(state);
  }

  /**
   * Get the current Curator state.
   */
  async getState(): Promise<CuratorState> {
    return loadCuratorState();
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let globalCurator: SkillCurator | null = null;

export function getDefaultCurator(): SkillCurator {
  if (!globalCurator) {
    globalCurator = new SkillCurator();
  }
  return globalCurator;
}

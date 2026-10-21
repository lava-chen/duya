/**
 * packages/agent/src/skills/rootSnapshotCache.ts
 *
 * Per-discovery-root snapshot cache for skill loading (plan 445), modeled
 * on codex's `SkillRootSnapshotCache` (harness-comparison skills-deep-dive).
 *
 * key   = configKey + rootPath. The configKey captures every input that
 *         changes how a root is *interpreted* (source, security scan
 *         toggles, bypass lists, bundled-name sets) so a settings change
 *         forces a rebuild even when the directory is untouched.
 * value = { fingerprint, skills }. The fingerprint is an mtime/size
 *         manifest hash; unchanged roots reuse the exact same PromptSkill
 *         object references instead of re-reading and re-parsing SKILL.md.
 *
 * Process-lifetime memory cache only: the agent process starts fresh per
 * session, so a disk snapshot layer (hermes-style) would add persistence
 * complexity with no cross-process benefit.
 */

import type { PromptSkill } from './types.js';
import { fingerprintDir } from './fingerprint.js';

interface SnapshotEntry {
  fingerprint: string;
  skills: PromptSkill[];
}

export class RootSnapshotCache {
  private readonly entries = new Map<string, SnapshotEntry>();

  private static keyFor(rootPath: string, configKey: string): string {
    return `${configKey}\u0000${rootPath}`;
  }

  /**
   * Return the cached skills for this root when the configKey matches and
   * the directory fingerprint is unchanged; otherwise call `resolve`,
   * store the snapshot, and return the fresh result.
   *
   * A missing root (fingerprint null) bypasses the cache — `resolve`
   * returns cheaply for nonexistent directories anyway. A fingerprint or
   * resolve failure counts as a miss: rebuilding is always safe, reusing
   * stale objects is not.
   */
  async get(
    rootPath: string,
    configKey: string,
    resolve: () => Promise<PromptSkill[]>,
  ): Promise<PromptSkill[]> {
    const key = RootSnapshotCache.keyFor(rootPath, configKey);

    let fingerprint: string | null = null;
    try {
      fingerprint = await fingerprintDir(rootPath);
    } catch {
      fingerprint = null;
    }
    if (fingerprint === null) {
      return resolve();
    }

    const cached = this.entries.get(key);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.skills;
    }

    const skills = await resolve();
    this.entries.set(key, { fingerprint, skills });
    return skills;
  }

  /** Drop snapshots for one root (all config variants), or everything. */
  invalidate(rootPath?: string): void {
    if (rootPath === undefined) {
      this.entries.clear();
      return;
    }
    const suffix = `\u0000${rootPath}`;
    for (const key of this.entries.keys()) {
      if (key.endsWith(suffix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

let globalCache: RootSnapshotCache | null = null;

export function getRootSnapshotCache(): RootSnapshotCache {
  if (!globalCache) {
    globalCache = new RootSnapshotCache();
  }
  return globalCache;
}

export function resetRootSnapshotCache(): void {
  globalCache = new RootSnapshotCache();
}

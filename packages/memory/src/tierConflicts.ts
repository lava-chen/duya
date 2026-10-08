/**
 * Bot memory tier conflict rules (Plan 479 Phase 1, P1.2).
 *
 * Pure functions — no DB, no filesystem, no clocks. All timestamps come
 * from the entries themselves so results are deterministic and testable.
 *
 * Semantics from plan 479 §3.1/§3.2:
 *   - Within one shard (same writer), the same dedupe key is a rewrite:
 *     newest-wins.
 *   - Across shards in a shared tier (user / project), the same dedupe
 *     key is a re-statement: cross-shard dedupe keeps the EARLIEST entry
 *     ("保留最早 via") — the writer who recorded the fact first becomes
 *     the via attribution; the suppressed later statements are returned
 *     for debugging/telemetry.
 *   - Merged recall precedence: own (agent tier) > project > user (§3.2).
 */

export type MemoryTier = 'agent' | 'user' | 'project';

export type TierEntryKind = 'profile' | 'log' | 'note';

export interface ConflictAccessors<T> {
  /** Dedupe key of the entry (already normalized by the producer). */
  keyOf: (entry: T) => string;
  /** Update timestamp (epoch ms) — newest-wins comparator. */
  timeOf: (entry: T) => number;
  /** Creation timestamp (epoch ms) — earliest-via comparator. Defaults to timeOf. */
  bornOf?: (entry: T) => number;
  /** Shard identifier (e.g. `user:<writer>`, `agent:<botId>`). */
  shardOf: (entry: T) => string;
}

/**
 * Newest-wins between two entries competing for the same key within a
 * shard. Ties keep `a` (the incumbent) so re-rendering an unchanged
 * snapshot never flips winners.
 */
export function newestWins<T>(a: T, b: T, timeOf: (entry: T) => number): T {
  return timeOf(b) > timeOf(a) ? b : a;
}

/**
 * Resolve same-key conflicts WITHIN a single shard: newest-wins per key.
 * Ties keep the first occurrence. Survivors keep first-appearance order.
 */
export function resolveShardConflicts<T>(
  entries: readonly T[],
  accessors: Pick<ConflictAccessors<T>, 'keyOf' | 'timeOf'>
): T[] {
  const winnerByKey = new Map<string, { entry: T; index: number }>();
  entries.forEach((entry, index) => {
    const key = accessors.keyOf(entry);
    const incumbent = winnerByKey.get(key);
    if (!incumbent) {
      winnerByKey.set(key, { entry, index });
      return;
    }
    winnerByKey.set(key, {
      entry: newestWins(incumbent.entry, entry, accessors.timeOf),
      index: incumbent.index,
    });
  });
  return [...winnerByKey.values()]
    .sort((a, b) => a.index - b.index)
    .map((w) => w.entry);
}

export interface CrossShardDedupeResult<T> {
  /** One entry per key — the earliest statement — with its via shard. */
  resolved: Array<{ entry: T; viaShard: string }>;
  /** Later re-statements of the same keys (newest last). */
  suppressed: T[];
}

/**
 * Cross-shard dedupe within one tier: group by key across shards, keep
 * the earliest statement ("保留最早 via"). Ties break on shard id
 * (lexicographic) then first occurrence, so the result is deterministic.
 * Output preserves first-appearance order of the surviving keys.
 */
export function dedupeAcrossShards<T>(
  entries: readonly T[],
  accessors: ConflictAccessors<T>
): CrossShardDedupeResult<T> {
  const bornOf = accessors.bornOf ?? accessors.timeOf;
  const winnerByKey = new Map<string, { entry: T; viaShard: string; born: number; index: number }>();
  const suppressed: T[] = [];

  entries.forEach((entry, index) => {
    const key = accessors.keyOf(entry);
    const born = bornOf(entry);
    const incumbent = winnerByKey.get(key);
    if (!incumbent) {
      winnerByKey.set(key, { entry, viaShard: accessors.shardOf(entry), born, index });
      return;
    }
    const challengerShard = accessors.shardOf(entry);
    const challengerWins =
      born < incumbent.born ||
      (born === incumbent.born && challengerShard < incumbent.viaShard);
    if (challengerWins) {
      suppressed.push(incumbent.entry);
      winnerByKey.set(key, { entry, viaShard: challengerShard, born, index: incumbent.index });
    } else {
      suppressed.push(entry);
    }
  });

  const resolved = [...winnerByKey.values()]
    .sort((a, b) => a.index - b.index)
    .map((w) => ({ entry: w.entry, viaShard: w.viaShard }));
  return { resolved, suppressed };
}

export interface MergeTierRecallInput<T> {
  /** The bot's own tier entries (single shard). */
  own: readonly T[];
  /** Project-tier entries across the bot's joined projects. */
  project: readonly T[];
  /** Shared user-tier entries across all writer shards. */
  user: readonly T[];
}

export interface MergedTierRecall<T> {
  /** One entry per dedupe key, tier precedence applied. */
  resolved: Array<{ entry: T; viaShard: string; tier: MemoryTier }>;
  /** Entries dropped by cross-shard dedupe or tier precedence. */
  suppressed: Array<{ entry: T; tier: MemoryTier }>;
}

/**
 * Merged recall across the three memory tiers (plan 479 §3.2):
 * per tier, cross-shard dedupe first; then tier precedence
 * agent > project > user per key. Keys absent from higher tiers surface
 * from lower tiers with their via attribution. Resolved output preserves
 * first-appearance order (own stream, then project, then user).
 */
export function mergeTierRecall<T>(
  input: MergeTierRecallInput<T>,
  accessors: ConflictAccessors<T>
): MergedTierRecall<T> {
  const tiers: Array<{ tier: MemoryTier; entries: readonly T[] }> = [
    { tier: 'agent', entries: input.own },
    { tier: 'project', entries: input.project },
    { tier: 'user', entries: input.user },
  ];

  const resolved = new Map<string, { entry: T; viaShard: string; tier: MemoryTier }>();
  const suppressed: Array<{ entry: T; tier: MemoryTier }> = [];

  for (const { tier, entries } of tiers) {
    const { resolved: tierResolved, suppressed: tierSuppressed } = dedupeAcrossShards(entries, accessors);
    for (const entry of tierSuppressed) {
      suppressed.push({ entry, tier });
    }
    for (const { entry, viaShard } of tierResolved) {
      const key = accessors.keyOf(entry);
      const incumbent = resolved.get(key);
      if (!incumbent) {
        resolved.set(key, { entry, viaShard, tier });
        continue;
      }
      // Tier precedence order == iteration order, so the incumbent is
      // always from a higher tier; the challenger is suppressed.
      suppressed.push({ entry, tier });
    }
  }

  return {
    resolved: [...resolved.values()],
    suppressed,
  };
}

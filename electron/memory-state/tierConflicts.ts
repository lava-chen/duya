/**
 * Re-export shim — the tier conflict rules moved to the agent-core
 * package (Plan 479 Phase 2): the bot memory section renderers consume
 * the same pure rules, and `packages/agent` must not import from
 * `electron/`. Keep the electron-side export surface stable here.
 */
export {
  newestWins,
  resolveShardConflicts,
  dedupeAcrossShards,
  mergeTierRecall,
  type MemoryTier,
  type TierEntryKind,
  type ConflictAccessors,
  type CrossShardDedupeResult,
  type MergeTierRecallInput,
} from '../../packages/agent/src/memory-state/tierConflicts';

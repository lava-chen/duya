/**
 * Memory state control-plane — public API.
 *
 * Plan 305 wires the memory-worker in the Electron main process,
 * which imports `bootstrap` / `getDb` / `closeDb` from here along
 * with `syncAllFromMainDb` for catalog sync. Plans 302-304 import
 * the schema types and migration registry as they add their own
 * migrations.
 */
export { resolveMemoryDbPath } from './path';
export {
  bootstrap,
  getDb,
  closeDb,
  isOpen,
  type BootstrapOptions,
} from './db';
export { runMigrations, MIGRATIONS, type Migration } from './migrations';
export { migration0001 } from './migrations/0001_init.sql';
export { migration0002 } from './migrations/0002_lease_stage1.sql';
export type {
  ProjectRow,
  ProjectPathAliasRow,
  ProjectPathEntry,
  ProjectBotRow,
  InsertProjectInput,
  InsertProjectAliasInput,
  InsertProjectBotInput,
  UpsertRolloutCatalogInput,
  AliasKind,
  ScopeKind,
  AgentType,
  SourceStatus,
} from './schema';
export { parseProjectPaths, serializeProjectPaths } from './schema';

// Phase B — project registry
export {
  resolveProject,
  resolveProjectWithDefaults,
  registerProject,
  defaultGitProbe,
  ProjectAliasConflictError,
  type ResolveProjectInput,
  type ResolveProjectResult,
} from './projectResolver';
export {
  loadWorkspaceOverrides,
  addWorkspaceOverride,
  removeWorkspaceOverride,
  type WorkspaceOverride,
} from './workspaceOverrides';
export { normalizePath, walkToExistingAncestor, type NormalizedPath } from './pathUtils';

// Phase C — main-DB catalog sync
export {
  syncAllFromMainDb,
  syncSessionFromMainDb,
  markSourceMissing,
  type SyncResult,
  type SyncSessionResult,
} from './catalogSync';
export {
  computeSourceFingerprint,
  readMessagesForFingerprint,
  type MessageForHash,
} from './sourceFingerprint';

// Plan 525 Phase 3 — project entity service + global plans directory
export {
  createProject,
  updateProject,
  deleteProject,
  listProjects,
  getProject,
  projectPaths,
  ensurePlansDirs,
  writePlansIndex,
  readPlansIndex,
  resolveProjectsRoot,
  projectPlansDir,
  normalizeProjectPathEntries,
  MAX_PROJECT_PATH_LENGTH,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ProjectServiceOptions,
  type PlanStatus,
  type PlansIndex,
  type PlansIndexEntry,
} from './projectService';

// Plan 479 Phase 1 — bot memory tier index (query index over the file manifest)
export {
  normalizeDedupeKey,
  computeTierEntryId,
  upsertTierEntry,
  listTierEntries,
  listTierShards,
  getTierEntryByPath,
  removeTierEntryByPath,
  mergedTierRecall,
  rebuildTierIndexFromFiles,
  type TierIndexRow,
  type UpsertTierEntryInput,
  type TierQueryFilter,
  type TierShardSummary,
  type TierRebuildReport,
  type UpsertOutcome,
} from './tierIndex';
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
} from './tierConflicts';

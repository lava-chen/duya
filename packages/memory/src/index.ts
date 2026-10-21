/**
 * `@duya/memory` -- Memory V2: layout, curation, rollout leases, and extraction.
 *
 * Plan 610 A5. Moved out of `packages/agent/src/memory-state/` and
 * `packages/agent/src/memory-rollout/`. Those two directories were one domain
 * split across two folders inside the agent package, which is why every host
 * consumer had to reach into the agent by relative path to use memory at all.
 *
 * The subpaths declared in `package.json` `exports` are the supported surface.
 * `.` re-exports them for convenience; a consumer that only needs the outbox
 * or only the lease contract imports that subpath directly. A module with no
 * declared subpath (`compactMessages`, `curation_validator`, `prompt`,
 * `stage1_prompt_loader`, `types`, `writer`) is package-private, and
 * `packages/memory/tests/package-boundary.test.ts` fails if anything outside
 * this package names it.
 *
 * Boundary: memory is a DOMAIN, not a capability and not a lifecycle. It knows
 * nothing about Goal / Task / Run, and it reaches storage only through the
 * `better-sqlite3` handle and the filesystem paths its caller passes in.
 */

export { parseCanonicalFile } from './canonical_file.js';
export type { ParsedCanonicalFile } from './canonical_file.js';

export {
  computeInputSetHash,
  claimRun,
  completeRun,
  failRun,
  abandonExpiredRuns,
  renewLease,
  queryEligibleInputs,
  countPriorDeferrals,
} from './curation_ledger.js';
export type {
  InputKind,
  CurationRunStatus,
  PublicationStatus,
  CacheStatus,
  Disposition,
  CurationInput,
  EligibleInput,
  InputDisposition,
  ClaimRunInput,
  ClaimRunResult,
  CompleteRunInput,
  QueryEligibleOpts,
} from './curation_ledger.js';

export {
  MEMORY_MD_MAX_BYTES,
  SUMMARY_MD_MAX_CHARS,
  SUMMARY_TOP_N,
  parseFrontmatter,
  generateMemoryMd,
  generateSummaryMd,
  generateIndexMd,
} from './curation_projection.js';

export {
  generateMemoryMdLive,
  generateSummaryMdLive,
  generateIndexMdLive,
} from './curation_projection_live.js';

export {
  DEFAULT_ELIGIBILITY_LIMIT,
  DEFAULT_IDLE_MS,
  DEFAULT_WINDOW_MS,
  DEFAULT_MIN_MESSAGE_COUNT,
  selectEligible,
  diagnoseEligibility,
} from './eligibility.js';
export type { EligibleRollout, EligibilityDiagnostic } from './eligibility.js';

export {
  DEFAULT_ENTITY_TYPES,
  dirNameToEntityType,
  isValidEntityDirName,
  listEntityDirsSync,
  listEntityDirs,
} from './entity_dirs.js';
export type { EntityDir } from './entity_dirs.js';

export { Stage1Extractor, parseAndValidate, queryExistingKeysFromFiles } from './extractor.js';
export type {
  ExtractInput,
  ExtractResult,
  ValidationResult,
  MessageRowShape,
  Stage1ExtractorOpts,
} from './extractor.js';

export {
  DEFAULT_LEASE_TTL_MS,
  HEARTBEAT_DIVISOR,
  MAX_RETRY_ATTEMPTS,
  BACKOFF_SEQUENCE_MINUTES,
  STALE_WORKER_GRACE_MS,
  backoffMs,
  computeRetryBackoffMs,
  shouldRetire,
  acquireLease,
  heartbeat,
  complete,
  fail,
} from './lease.js';
export type {
  LeaseJobStatus,
  RolloutLeaseRow,
  Stage1JobStatus,
  ContentOutcome,
  AcquireOk,
  AcquireBusy,
  AcquireResult,
  CompleteStatus,
} from './lease.js';

export {
  DEFAULT_LAYOUT,
  parseLayout,
  validateLayoutChange,
  renderLayoutForPrompt,
} from './memory_layout.js';
export type {
  MemoryEntityConfig,
  MemoryLayout,
  LayoutValidationError,
  LayoutChangeValidationResult,
} from './memory_layout.js';

export { getDuyaRoot, getDuyaMemoryRoot } from './memory_paths.js';

export {
  outboxBackoffMs,
  computeContentHash,
  assertSafe,
  enqueueProjectionOutbox,
  drainOutbox,
} from './outbox.js';
export type { EnqueueInput, EnqueueResult, OutboxRow, DrainHooks, DrainOptions } from './outbox.js';

export {
  rolloutShortId,
  sanitizeRolloutSlug,
  deriveRolloutSummaryFilename,
  renderRolloutSummaryFile,
} from './projectionContent.js';
export type { Stage1OutputRow } from './projectionContent.js';

export { reconcileProjections, purgeDegradedOutputs } from './reconcile.js';
export type { ReconcileReport, ReconcileOptions, PurgeDegradedResult } from './reconcile.js';

export {
  MAX_POLICY_BYTES,
  MAX_EDITS_PER_RUN,
  MAX_RULE_TEXT,
  POLICY_SECTION_DEFS,
  POLICY_SECTION_IDS,
  POLICY_EDIT_OPTS,
  POLICY_RULE_ID_RE,
  POLICY_SECTION_RE,
  parsePolicy,
  serializePolicy,
  isAnchoredPolicy,
  migrateLegacyPolicy,
  normalizePolicy,
  readPolicyForPrompt,
  applyPolicyEdits,
} from './stage1_policy_editor.js';
export type {
  PolicyRule,
  PolicySection,
  PolicyDocument,
  PolicyEdit,
  PolicyEditResult,
} from './stage1_policy_editor.js';

export { systemLogPathFor, writeSystemLog, listSystemLog } from './system_log.js';
export type {
  MemoryLogPhase,
  MemoryLogLevel,
  MemoryLogEntry,
  WriteSystemLogInput,
  ListSystemLogOpts,
  ListSystemLogResult,
} from './system_log.js';

export {
  newestWins,
  resolveShardConflicts,
  dedupeAcrossShards,
  mergeTierRecall,
} from './tierConflicts.js';
export type {
  MemoryTier,
  TierEntryKind,
  ConflictAccessors,
  CrossShardDedupeResult,
  MergeTierRecallInput,
  MergedTierRecall,
} from './tierConflicts.js';

export { sendMemoryWakeup, isMemoryEnabled } from './wakeup.js';
export type {
  MemoryWakeupEvent,
  SendWakeupFn,
  SendMemoryWakeupOptions,
} from './wakeup.js';
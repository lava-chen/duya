/**
 * Memory long-lived worker (Plan 305 Phase A + Plan 306 Phase B).
 *
 * Runs in the Electron main process. Owns a `setInterval` loop that
 * periodically:
 *   1. reconciles the file projection from DB (first tick only)
 *   2. selects eligible rollouts (`selectEligible`, limited to
 *      `concurrency` per tick)
 *   3. fires `Stage1Extractor.extract` for each, in parallel, via
 *      `Promise.allSettled` (one failing rollout does NOT kill the batch)
 *   4. drains the projection outbox (`drainOutbox`)
 *   5. runs the Phase 2 curation cycle (`runCurationCycle`) via the Hybrid
 *      scheduler on a separate interval, and immediately after any tick
 *      that produced new Stage 1 outputs, so fresh extractions are
 *      promoted to canonical memory without waiting for the next sweep.
 *
 * Shadow mode (D1, revised by Plan 306 Phase B): the worker writes to
 * the memory-state DB and projection files under `~/.duya/memory`
 * (including the unified root Phase 2 projections). It never
 * touches `packages/agent/src/memory/` (the existing MemoryManager
 * path) — the agent read path still goes through MemoryManager until
 * Plan 306 Phase E flips the switch.
 *
 * Gated by `DUYA_MEMORY_ENABLED` at the call site (electron/main.ts);
 * this module itself is import-safe and does nothing until
 * `startMemoryWorker` is called.
 */

import type { Database } from 'better-sqlite3';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { getLogger, LogComponent } from '../logging/logger';
import type { AIClient } from '@duya/ai';
import { Stage1Extractor, type MessageRowShape } from '../../packages/agent/src/memory-rollout/extractor.js';
import {
  selectEligible,
  diagnoseEligibility,
  type EligibilityDiagnostic,
  DEFAULT_IDLE_MS,
  DEFAULT_WINDOW_MS,
} from '../../packages/agent/src/memory-state/eligibility.js';
import { drainOutbox } from '../../packages/agent/src/memory-state/outbox.js';
import { readConfigAgents } from '../../packages/agent/src/agent-profile/config-agents.js';
import {
  reconcileProjections,
  purgeDegradedOutputs,
} from '../../packages/agent/src/memory-state/reconcile.js';
import { queryEligibleInputs } from '../../packages/agent/src/memory-state/curation_ledger.js';
import { writeSystemLog } from '../../packages/agent/src/memory-state/system_log.js';
import { syncAllFromMainDb } from '../memory-state/catalogSync';
import { runCurationCycle } from './curation_publish_orchestrator';
import type { ProviderConfig } from './curation_publish_orchestrator';
import type { CoreDatabase, SessionStore } from '../db/core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryWorkerDeps {
  /** Memory-state DB (must be bootstrapped + migrated before start). */
  memoryDb: Database;
  /**
   * Main DUYA DB (read-only — used for message reads by the Stage 1
   * extractor, which still imports `readMessages` from the legacy
   * `messages` table until plan 328 Phase 6 migrates it).
   */
  mainDb: Database;
  /**
   * Core database (`duya-core.db`) handle — passed to `catalogSync`
   * for `message_index` reads (plan 328 decision 10). Optional for
   * backwards compat with tests that have not been migrated yet.
   */
  coreDb?: CoreDatabase;
  /**
   * Core `SessionStore` — `catalogSync` reads session rows (including
   * deleted tombstones) via `SessionStore.list({ includeDeleted: true })`.
   * Optional for backwards compat with tests that have not been migrated.
   */
  sessions?: SessionStore;
  /**
   * Override the Stage 1 extractor's message source. The Main-process
   * MemoryWorker has no `process.send` IPC, so it supplies a reader that
   * pulls flat rows from the core store MessageLog via
   * `storedEventsToIpcMessages`. When absent, the extractor falls back to
   * the agent `messageDb.getBySession` IPC path (tests mock this).
   */
  readMessageRows?: (sessionId: string) => Promise<MessageRowShape[]>;
  /** LLM client for Stage 1 extraction. */
  llmClient: AIClient;
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
  /**
   * Optional Phase 2 curation cycle wiring (Plan 406). When present, the
   * worker runs `runCurationCycle` via the Hybrid scheduler instead of the
   * legacy consolidator. When absent, the legacy consolidator path is used.
   */
  curation?: CurationWorkerDeps;
  /**
   * Bot profile ids excluded from the session memory pipeline (Plan 479):
   * their sessions never become Stage 1 extraction inputs — bot memory is
   * fed by update_state writes into the tier store instead. When absent,
   * resolved per sweep from `~/.duya/config.toml` `[agents]` (tests inject
   * a fixed list).
   */
  listBotAgentIds?: () => Promise<string[]>;
}

/**
 * Curation-cycle dependencies needed to drive `runCurationCycle` from the
 * memory worker (design §9.1 Hybrid scheduler). These are the same roots the
 * orchestration tests construct, but resolved at worker startup.
 */
export interface CurationWorkerDeps {
  /** Root that holds `stage1_policy.md` + `memory_layout.json` (memory-config). */
  configRoot: string;
  /** LLM provider config forwarded to the curator agent process. */
  providerConfig: ProviderConfig;
  /**
   * Post-curation RAG index refresh (plan 428). Invoked with the memory
   * root after every successful `runCurationCycle`; best-effort.
   */
  ragRefresh?: (memoryRoot: string) => Promise<void>;
}

export interface MemoryWorkerConfig {
  /**
   * Tick interval in ms (Phase 1 extraction sweep). Default 300_000
   * (5 min). The tick checks the rollout catalog for eligible sessions,
   * syncs the catalog when stale, and drains the outbox.
   */
  extractEveryMs: number;
  /** Parallel extracts per tick. Default 2 (limits LLM rate-limit risk). */
  concurrency: number;
  /** Outbox drain interval in ms. Default 60_000. */
  sweepOutboxEveryMs: number;
  /** Run `reconcileProjections` on the first tick. Default true. */
  reconcileOnStart: boolean;
  /** Start paused; interval ticks are no-ops until `resume()`. Default false. */
  paused: boolean;
  /** Idle window for eligibility (ms). Default 6h. */
  idleMs: number;
  /** Lookback window for eligibility (ms). Default 30d. */
  windowMs: number;
  /**
   * Phase 2 consolidator sweep interval in ms. Default 300_000 (5 min).
   * The consolidator also runs immediately after any tick that produced
   * new Stage 1 outputs, so this interval mainly covers ad-hoc file
   * digestion when no extractions are happening.
   */
  consolidatorIntervalMs: number;
  /**
   * When true, the consolidator runs on every forceSweep regardless of
   * the interval timer. Default true (manual trigger should be eager).
   */
  consolidatorOnForceSweep: boolean;
  /**
   * Catalog sync interval in ms. The main DB is rescanned for new/changed
   * chat_sessions at most this often. Default 60_000 (1 min). forceSweep
   * always triggers a sync regardless of this value.
   */
  catalogSyncIntervalMs: number;
  /**
   * Minimum gap between extraction batches in ms. Prevents LLM rate-limit
   * spikes when many sessions become eligible simultaneously (e.g. a burst
   * of short sessions 6h ago all crossing the idle threshold at once).
   * Default 120_000 (2 min).
   */
  extractCooldownMs: number;
  /**
   * Minimum message count for a session to be eligible for extraction.
   * Filters out thin sessions that produce low-quality rollouts. Default 6.
   */
  minMessageCount: number;
  /**
   * Suppress extraction for a project when a sibling session was recently
   * extracted. Prevents batch floods within a single project.
   * Default 600_000 (10 min).
   */
  projectCooldownMs: number;
  /**
   * Wall-clock budget (ms) for a single curator agent run in the Phase 2
   * curation cycle. Forwarded to `runCurationCycle`, which uses it for both
   * the run lease TTL and the agent hard deadline. The outer cycle deadline
   * is derived from this value (budget + margin). Default 1_200_000 (20 min).
   */
  curationTimeoutMs: number;
}

export interface ForceSweepResult {
  selected: number;
  extracted: number;
  skippedNoop: number;
  outboxDrained: number;
  reconciled: { written: number; removed: number; mismatched: number } | null;
  /** Phase 2 curation cycle result; null when the curation cycle was not run. */
  curated: CurationTickResult | null;
  /** Catalog sync result; null when sync was not run this tick. */
  catalogSynced: { inserted: number; updated: number; tombstoned: number; errors: number } | null;
  durationMs: number;
}

export interface MemoryWorkerHandle {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  shutdown(): Promise<void>;
  forceSweep(): Promise<ForceSweepResult>;
  /** Test-only: run a non-forced curation tick (Hybrid patience path). */
  curationTickForTest(): Promise<CurationTickResult>;
  /** Worker instance identifier (for `claimedBy` lease field). */
  readonly workerId: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_WORKER_CONFIG: MemoryWorkerConfig = {
  extractEveryMs: 5 * 60_000, // 5 min between Phase 1 sweep ticks
  concurrency: 2,
  sweepOutboxEveryMs: 60_000,
  reconcileOnStart: true,
  paused: false,
  idleMs: DEFAULT_IDLE_MS,
  windowMs: DEFAULT_WINDOW_MS,
  // Token budget control (Plan 417 follow-up): curation polls every 30 min
  // instead of 5 min, and Stage 1 cooldown widened to 5 min, so the memory
  // system makes at most a handful of LLM calls per day instead of dozens.
  consolidatorIntervalMs: 30 * 60_000, // 30 min
  consolidatorOnForceSweep: true,
  catalogSyncIntervalMs: 60_000, // 1 min
  extractCooldownMs: 300_000, // 5 min — space batches to avoid LLM rate-limit spikes
  minMessageCount: 3, // filter very thin sessions only
  projectCooldownMs: 10 * 60_000, // 10 min — suppress sibling extraction floods
  curationTimeoutMs: 4 * 60_000, // 4 min — single-shot curator chat() budget
};

// ---------------------------------------------------------------------------
// Low-power overrides (plan 426 Phase 6.1)
// ---------------------------------------------------------------------------

/** Low-power tick floor: 5s between extraction ticks (vs 5min default). */
export const LOW_POWER_MIN_TICK_MS = 5_000;
/** Low-power catalogSync throttle (vs 60s default). */
export const LOW_POWER_CATALOG_SYNC_INTERVAL_MS = 5 * 60_000;

/**
 * Apply low-power overrides to caller-provided worker config (plan 426
 * Phase 6.1). `extractEveryMs` is floored so the effective tick interval
 * is at least LOW_POWER_MIN_TICK_MS, and `catalogSyncIntervalMs`
 * is throttled to at least LOW_POWER_CATALOG_SYNC_INTERVAL_MS. Pure —
 * callers pass the resolved lowPower flag (see services/low-power.ts).
 */
export function applyLowPowerOverrides(
  cfg: Partial<MemoryWorkerConfig>,
  lowPower: boolean,
): Partial<MemoryWorkerConfig> {
  if (!lowPower) return cfg;
  const base = { ...DEFAULT_WORKER_CONFIG, ...cfg };
  return {
    ...cfg,
    extractEveryMs: Math.max(
      base.extractEveryMs,
      LOW_POWER_MIN_TICK_MS,
    ),
    catalogSyncIntervalMs: Math.max(
      base.catalogSyncIntervalMs,
      LOW_POWER_CATALOG_SYNC_INTERVAL_MS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Phase 2 curation switch + Hybrid scheduler (Plan 406, design §9.1)
// ---------------------------------------------------------------------------

/**
 * Race a promise against a hard wall-clock deadline so it is guaranteed
 * to settle (resolve or reject) within `timeoutMs`. Used to bound the
 * curation cycle so a hung cycle can never permanently occupy the
 * `consolidatorInFlight` single-flight guard.
 */
function withWallClockDeadline<T>(fn: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    fn.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Fire the curation cycle when ≥ this many eligible inputs accumulate. */
const HYBRID_MIN_INPUTS = 4;
/** Or when the oldest eligible input has sat this long (2 h). */
const HYBRID_MAX_AGE_MS = 2 * 60 * 60_000;
/** Eligibility scan window for the Hybrid trigger (reuse the ledger query). */
const HYBRID_QUORUM_MAX_INPUTS = 100;
const HYBRID_QUORUM_MAX_BYTES = 512 * 1024;

export interface CurationTickResult {
  ran: boolean;
  runId: string | null;
  status: string;
  durationMs: number;
}

/**
 * Compute the Hybrid scheduler quorum (design §9.1, simplified flow):
 *   - rollout inputs: `queryEligibleInputs` (stage1_outputs not yet consumed)
 *
 * Returns the total eligible count and the age (ms) of the oldest eligible
 * input. When nothing is eligible, oldestAgeMs is 0 so the T=30min trigger
 * cannot fire on an empty queue.
 */
async function curationQuorum(
  db: Database,
  _memoryRoot: string,
): Promise<{ eligibleCount: number; oldestAgeMs: number }> {
  const now = Date.now();
  const rollout = queryEligibleInputs(db, {
    maxInputs: HYBRID_QUORUM_MAX_INPUTS,
    maxInputBytes: HYBRID_QUORUM_MAX_BYTES,
    now,
  });
  const all = rollout;
  if (all.length === 0) return { eligibleCount: 0, oldestAgeMs: 0 };
  const oldest = Math.min(...all.map((i) => i.outputUpdatedAt));
  return { eligibleCount: all.length, oldestAgeMs: now - oldest };
}

// ---------------------------------------------------------------------------
// Singleton handle
// ---------------------------------------------------------------------------

let handle: MemoryWorkerHandle | null = null;

/**
 * Start the memory worker. Returns the singleton handle; a second call
 * returns the existing handle (deps/config from the second call are
 * ignored). Call `shutdown()` to tear down before starting again.
 *
 * `globalThis.__memoryWorkerHandle__` is set so cross-module code can
 * reach the handle via `getMemoryWorkerHandle()` without import cycles.
 */
export function startMemoryWorker(
  deps: MemoryWorkerDeps,
  cfg?: Partial<MemoryWorkerConfig>,
): MemoryWorkerHandle {
  if (handle) {
    return handle;
  }
  handle = createWorker(deps, { ...DEFAULT_WORKER_CONFIG, ...cfg });
  (globalThis as { __memoryWorkerHandle__?: MemoryWorkerHandle }).__memoryWorkerHandle__ = handle;
  return handle;
}

/**
 * Get the running worker handle, or null if not started.
 */
export function getMemoryWorkerHandle(): MemoryWorkerHandle | null {
  return (
    handle ??
    (globalThis as { __memoryWorkerHandle__?: MemoryWorkerHandle }).__memoryWorkerHandle__ ??
    null
  );
}

/**
 * Test-only: clear the singleton so a fresh worker can be started.
 * Production code MUST NOT call this.
 */
export function _resetMemoryWorkerForTesting(): void {
  if (handle) {
    try {
      handle.shutdown();
    } catch {
      // Best-effort during test teardown.
    }
  }
  handle = null;
  delete (globalThis as { __memoryWorkerHandle__?: MemoryWorkerHandle }).__memoryWorkerHandle__;
}

// ---------------------------------------------------------------------------
// Worker implementation
// ---------------------------------------------------------------------------

interface WorkerState {
  deps: MemoryWorkerDeps;
  cfg: MemoryWorkerConfig;
  extractor: Stage1Extractor;
  workerId: string;
  tickTimer: ReturnType<typeof setInterval> | null;
  outboxTimer: ReturnType<typeof setInterval> | null;
  curationTimer: ReturnType<typeof setInterval> | null;
  /** Outcome of the most recently COMPLETED curation tick (any trigger). */
  lastCurationTick: CurationTickResult | null;
  paused: boolean;
  tickInFlight: boolean;
  forceSweepInFlight: boolean;
  consolidatorInFlight: boolean;
  reconciledThisInstance: boolean;
  inFlightExtracts: Set<Promise<unknown>>;
  shutdownSignal: boolean;
  lastCatalogSyncAt: number;
  lastExtractAt: number;
  lastPhase1ExplainAt: number;
}

function createWorker(
  deps: MemoryWorkerDeps,
  cfg: MemoryWorkerConfig,
): MemoryWorkerHandle {
  const logger = getLogger();
  const workerId = `memory-worker-${crypto.randomUUID()}`;
  const extractor = new Stage1Extractor(deps.memoryDb, deps.mainDb, deps.llmClient, {
    rootDir: deps.rootDir,
    // Live policy file managed by the curation loop (missing file = default
    // empty policy, so unwired deployments behave exactly as before).
    policyPath: deps.curation ? path.join(deps.curation.configRoot, 'stage1_policy.md') : undefined,
    // Main process has no `process.send` IPC — read messages from the core
    // store MessageLog directly instead of the agent db-client bridge.
    readMessageRows: deps.readMessageRows,
  });

  const state: WorkerState = {
    deps,
    cfg,
    extractor,
    workerId,
    tickTimer: null,
    outboxTimer: null,
    curationTimer: null,
    lastCurationTick: null,
    paused: cfg.paused,
    tickInFlight: false,
    forceSweepInFlight: false,
    consolidatorInFlight: false,
    reconciledThisInstance: false,
    inFlightExtracts: new Set(),
    shutdownSignal: false,
    lastCatalogSyncAt: 0,
    lastExtractAt: 0,
    lastPhase1ExplainAt: 0,
  };

  const tickIntervalMs = Math.max(1_000, cfg.extractEveryMs);

  // Phase 2 curation cycle — single-flight Hybrid scheduler (design §9.1).
  // After Phase D (Task 11) the legacy `consolidatorTick` is deleted, so
  // this is the only Phase 2 driver. Applies the Hybrid trigger: force
  // always fires; otherwise N ≥ HYBRID_MIN_INPUTS eligible inputs OR the
  // oldest eligible input age ≥ HYBRID_MAX_AGE_MS.
  const curationTickInner = async (options: {
    force: boolean;
  }): Promise<CurationTickResult> => {
    if (state.consolidatorInFlight) {
      return { ran: false, runId: null, status: 'skipped_in_flight', durationMs: 0 };
    }
    state.consolidatorInFlight = true;
    const start = Date.now();
    try {
      const memoryRoot = deps.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
      const quorum = await curationQuorum(deps.memoryDb, memoryRoot);
      const shouldFire =
        options.force ||
        quorum.eligibleCount >= HYBRID_MIN_INPUTS ||
        quorum.oldestAgeMs >= HYBRID_MAX_AGE_MS;
      if (!shouldFire) {
        return { ran: false, runId: null, status: 'skipped_no_quorum', durationMs: Date.now() - start };
      }

      const curation = deps.curation;
      if (!curation) {
        return { ran: false, runId: null, status: 'skipped_no_curation_deps', durationMs: Date.now() - start };
      }

      const result = await withWallClockDeadline(
        runCurationCycle(deps.memoryDb, {
          memoryRoot,
          configRoot: curation.configRoot,
          providerConfig: curation.providerConfig,
          workerId: state.workerId,
          sessionId: `curation-${state.workerId}`,
          llmClient: deps.llmClient,
          curationTimeoutMs: cfg.curationTimeoutMs,
          ragRefresh: curation.ragRefresh,
        }),
        // Outer cycle deadline must exceed the LLM call budget (cfg.curationTimeoutMs)
        // plus the file-apply + projection-drain overhead. The single-shot
        // path returns RunResult.success/failure rather than throwing on most
        // failures, so this wrapper only fires for genuinely hung cycles.
        cfg.curationTimeoutMs + 2 * 60_000,
        'curation cycle',
      );
      logger.warn(
        'MemoryWorkerCurationCycle',
        {
          runId: result.runId ?? null,
          skipped: result.skipped,
          success: result.success,
          error: result.error ?? null,
          durationMs: Date.now() - start,
          forced: options.force,
        },
        LogComponent.DB,
      );
      return {
        ran: !result.skipped,
        runId: result.runId ?? null,
        status: result.success ? 'succeeded' : result.skipped ? 'skipped' : 'failed',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      logger.warn(
        'MemoryWorkerCurationCycle failed',
        { error: err instanceof Error ? err.message : String(err), forced: options.force },
        LogComponent.DB,
      );
      return { ran: false, runId: null, status: 'failed', durationMs: Date.now() - start };
    } finally {
      state.consolidatorInFlight = false;
    }
  };

  // Wrapper that records the outcome of every completed tick (any trigger —
  // timer, post-extract, or forceSweep) so the tick summary can report the
  // real Phase 2 status instead of a constant false.
  const curationTick = async (options: {
    force: boolean;
  }): Promise<CurationTickResult> => {
    const result = await curationTickInner(options);
    state.lastCurationTick = result;
    return result;
  };

  // The loop body. Shared between the interval tick and forceSweep.
  const runTick = async (options: {
    force: boolean;
  }): Promise<ForceSweepResult> => {
    const start = Date.now();
    const { memoryDb, rootDir } = deps;
    const now = Date.now();

    // Reconcile on first non-paused tick (or any forceSweep when not yet done).
    let reconciled: ForceSweepResult['reconciled'] = null;
    if (
      cfg.reconcileOnStart &&
      !state.reconciledThisInstance &&
      (options.force || !state.paused)
    ) {
      state.reconciledThisInstance = true;
      try {
        // Self-healing: drop tolerant-fallback shells (rollout_slug=
        // 'memory-items', no narrative) so those rollouts become eligible
        // again and their empty files are cleaned up as orphans below.
        let purged = 0;
        try {
          purged = purgeDegradedOutputs(memoryDb).purgedRows;
        } catch (err) {
          logger.warn(
            'MemoryWorkerPurgeDegraded failed',
            { error: err instanceof Error ? err.message : String(err) },
            LogComponent.DB,
          );
        }
        const r = reconcileProjections(memoryDb, { rootDir, dryRun: false, now });
        reconciled = { written: r.written.length, removed: r.removed.length, mismatched: r.mismatched.length };
        logger.warn(
          'MemoryWorkerReconcile',
          { purgedDegraded: purged, written: reconciled.written, removed: reconciled.removed, mismatched: reconciled.mismatched, durationMs: r.durationMs },
          LogComponent.DB,
        );
      } catch (err) {
        logger.warn(
          'MemoryWorkerReconcile failed',
          { error: err instanceof Error ? err.message : String(err) },
          LogComponent.DB,
        );
      }
    }

    // Catalog sync: materialize sessions from the core DB into
    // rollout_catalog. Throttled to catalogSyncIntervalMs on regular
    // ticks; always runs on forceSweep. Without this step, the catalog
    // stays empty and selectEligible returns nothing forever.
    //
    // Plan 328 Phase 5: the source switched from the legacy
    // `chat_sessions`/`messages` tables to the core `sessions` store +
    // `message_index` rows. The coreDb handle is required for the
    // `message_index` fingerprint reads (decision 10).
    let catalogSynced: ForceSweepResult['catalogSynced'] = null;
    const syncStale = now - state.lastCatalogSyncAt >= cfg.catalogSyncIntervalMs;
    if (options.force || syncStale) {
      try {
        if (!deps.coreDb || !deps.sessions) {
          throw new Error(
            'catalogSync requires coreDb + sessions store (plan 328 Phase 5); ' +
              'pass them via MemoryWorkerDeps',
          );
        }
        const syncResult = syncAllFromMainDb({
          coreDb: deps.coreDb.db,
          sessions: deps.sessions,
          memoryDb,
        });
        state.lastCatalogSyncAt = now;
        catalogSynced = {
          inserted: syncResult.inserted,
          updated: syncResult.updated,
          tombstoned: syncResult.tombstoned,
          errors: syncResult.errors,
        };
        if (syncResult.inserted > 0 || syncResult.updated > 0 || syncResult.tombstoned > 0) {
          logger.warn(
            'MemoryWorkerCatalogSync',
            { inserted: syncResult.inserted, updated: syncResult.updated, tombstoned: syncResult.tombstoned, errors: syncResult.errors, durationMs: syncResult.durationMs, forced: options.force },
            LogComponent.DB,
          );
        }
      } catch (err) {
        logger.warn(
          'MemoryWorkerCatalogSync failed',
          { error: err instanceof Error ? err.message : String(err) },
          LogComponent.DB,
        );
      }
    }

    // Select eligible rollouts (limit to concurrency per tick).
    // Skip when extract cooldown has not elapsed (prevents LLM rate-limit
    // spikes when many sessions become eligible simultaneously). forceSweep
    // ignores the cooldown.
    let eligible: ReturnType<typeof selectEligible> = [];
    const cooldownActive =
      cfg.extractCooldownMs > 0 && now - state.lastExtractAt < cfg.extractCooldownMs;
    if (options.force || !cooldownActive) {
      try {
        // Plan 479: bot sessions never enter Stage 1 extraction. Resolve
        // the bot id list per sweep (bots can be created at runtime);
        // a resolution failure fails open (empty list = old behavior).
        let excludeAgentProfileIds: string[] = [];
        try {
          excludeAgentProfileIds = deps.listBotAgentIds
            ? await deps.listBotAgentIds()
            : Object.keys(await readConfigAgents());
        } catch (err) {
          logger.warn(
            'MemoryWorkerBotIdResolution failed — extraction runs unfiltered this tick',
            { error: err instanceof Error ? err.message : String(err) },
            LogComponent.DB,
          );
        }
        eligible = selectEligible(memoryDb, {
          now,
          limit: cfg.concurrency,
          idleMs: cfg.idleMs,
          windowMs: cfg.windowMs,
          minMessageCount: cfg.minMessageCount,
          projectCooldownMs: cfg.projectCooldownMs,
          excludeAgentProfileIds,
        });
      } catch (err) {
        logger.warn(
          'MemoryWorkerSelectEligible failed',
          { error: err instanceof Error ? err.message : String(err) },
          LogComponent.DB,
        );
      }
    }

    // Pre-compute existing canonical_keys once per batch so all parallel
    // extracts share the same dedup context. Passing the same list to
    // every extract avoids N independent DB queries and ensures
    // consistent key reuse decisions across the batch.
    let existingKeys: string[] | null = null;
    try {
      const rows = memoryDb
        .prepare("SELECT DISTINCT canonical_key FROM memory_entries WHERE status = 'active' ORDER BY canonical_key ASC")
        .all() as Array<{ canonical_key: string }>;
      existingKeys = rows.map((r) => r.canonical_key);
    } catch {
      // Table missing (pre-migration) — omit keys section.
      existingKeys = null;
    }

    // Fire extracts in parallel; allSettled so one failure doesn't kill the batch.
    const extractPromises = eligible.map((r) =>
      state.extractor
        .extract({ rolloutId: r.rolloutId, claimedBy: workerId, existingKeys })
        .catch((err) => {
          // Extractor returns failures as ExtractResult; only unexpected throws land here.
          logger.warn(
            'MemoryWorkerExtract threw unexpectedly',
            { rolloutId: r.rolloutId, error: err instanceof Error ? err.message : String(err) },
            LogComponent.DB,
          );
          return { status: 'failed' as const, contentOutcome: null, projectionPath: null, stage1RowId: r.rolloutId, durationMs: 0, errorMessage: 'unexpected-throw' };
        }),
    );
    for (const p of extractPromises) {
      state.inFlightExtracts.add(p);
      p.finally(() => state.inFlightExtracts.delete(p));
    }

    const settled = await Promise.allSettled(extractPromises);
    let extracted = 0;
    let skippedNoop = 0;
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      const r = result.value as { status: string };
      if (r.status === 'committed' || r.status === 'succeeded_no_output') {
        extracted += 1;
      } else if (r.status === 'noop_skipped' || r.status === 'stale_source') {
        skippedNoop += 1;
      }
    }
    if (extracted > 0) {
      state.lastExtractAt = Date.now();
    }

    // Explain (to the system log, throttled) why no new rollout was
    // produced this tick. Without this, an idle phase1 is indistinguishable
    // from a broken one: `selectEligible` returns [] silently and the
    // extractor never runs, so no extract_* event is ever written.
    if (extracted === 0 && Date.now() - state.lastPhase1ExplainAt > cfg.consolidatorIntervalMs) {
      const explainAt = Date.now();
      if (cooldownActive) {
        state.lastPhase1ExplainAt = explainAt;
        const remainingMs = Math.max(0, cfg.extractCooldownMs - (explainAt - state.lastExtractAt));
        writeSystemLog({
          phase: 'phase1',
          eventType: 'extract_delayed_cooldown',
          message: `Extraction delayed by cooldown (${Math.ceil(remainingMs / 1000)}s remaining)`,
          detail: { remaining_ms: remainingMs },
        });
      } else if (eligible.length === 0) {
        state.lastPhase1ExplainAt = explainAt;
        let diag: EligibilityDiagnostic | null = null;
        try {
          diag = diagnoseEligibility(memoryDb, {
            now: explainAt,
            idleMs: cfg.idleMs,
            windowMs: cfg.windowMs,
            minMessageCount: cfg.minMessageCount,
          });
        } catch {
          diag = null;
        }
        writeSystemLog({
          phase: 'phase1',
          eventType: 'extract_no_eligible',
          message: diag
            ? `No rollouts eligible for extraction (activeMain=${diag.activeMain}/${diag.total}, enoughMessages=${diag.enoughMessages}, idleReady=${diag.idleReady}, alreadyExtracted=${diag.alreadyExtracted})`
            : 'No rollouts eligible for extraction',
          detail: diag ?? { note: 'diagnostic query unavailable' },
        });
      }
    }

    // Drain outbox. Pass the configured rootDir as an allowed root so
    // projections under a non-default root (e.g. tests, custom data dir)
    // are writable. defaultMemoryRoot() is always included by assertSafe.
    let outboxDrained = 0;
    try {
      const allowedRoots = deps.rootDir ? [deps.rootDir] : undefined;
      outboxDrained = drainOutbox(memoryDb, { batchSize: 32, allowedRoots });
    } catch (err) {
      logger.warn(
        'MemoryWorkerOutbox drain failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }

    // Phase 2 curation cycle: run eagerly when this tick produced new
    // Stage 1 outputs (so fresh extractions are promoted without waiting
    // for the interval), or when forceSweep requests it. The curation
    // cycle uses the Hybrid scheduler (design §9.1). After Phase D the
    // legacy consolidator path is removed.
    // Do NOT await curation inside the tick — a hung curation must never
    // freeze the phase1 extraction loop. This eager trigger only complements
    // the independent curation sweeper below: it promotes fresh extractions
    // without waiting for the next interval. The quorum gate inside
    // curationTick still applies on non-forced ticks, so an empty queue is a
    // cheap no-op.
    if ((extracted > 0 || (options.force && cfg.consolidatorOnForceSweep)) && deps.curation) {
      curationTick({ force: options.force }).catch(() => { /* logged inside */ });
    }

    const tickSummary = {
      selected: eligible.length,
      extracted,
      skippedNoop,
      outboxDrained,
      // Status of the most recently completed curation cycle (any trigger).
      // Curation runs detached from the tick, so this is observational —
      // the cycle itself logs as MemoryWorkerCurationCycle when it runs.
      curatedLast: state.lastCurationTick?.status ?? null,
      catalogSynced: catalogSynced ? (catalogSynced.inserted + catalogSynced.updated + catalogSynced.tombstoned) : 0,
      forced: options.force,
      durationMs: Date.now() - start,
    };

    // Log every tick at INFO for debugging; escalate to WARN when
    // something actually happened so operators can see activity.
    const hasActivity = extracted > 0 || outboxDrained > 0
      || (catalogSynced && (catalogSynced.inserted + catalogSynced.updated + catalogSynced.tombstoned) > 0);
    if (hasActivity) {
      logger.warn('MemoryWorkerTick', tickSummary, LogComponent.DB);
    } else {
      logger.info('MemoryWorkerTick', tickSummary, LogComponent.DB);
    }

    return {
      selected: eligible.length,
      extracted,
      skippedNoop,
      outboxDrained,
      reconciled,
      // Curation is always detached from the tick (fire-and-forget), so an
      // awaited per-tick result no longer exists. Live status is observable
      // via the MemoryWorkerCurationCycle log and `curatedLast` in the tick
      // summary above; the field stays null for interface stability.
      curated: null,
      catalogSynced,
      durationMs: Date.now() - start,
    };
  };

  // Interval tick — skips when paused or when a previous tick is still running.
  const tick = (): void => {
    if (state.shutdownSignal) return;
    if (state.paused) {
      return;
    }
    if (state.tickInFlight) {
      // Previous tick still running — skip this one (LLM calls can outlast
      // a 1s interval). The next interval will pick up new work.
      return;
    }
    state.tickInFlight = true;
    runTick({ force: false })
      .catch((err) => {
        logger.warn(
          'MemoryWorkerTick failed',
          { error: err instanceof Error ? err.message : String(err) },
          LogComponent.DB,
        );
      })
      .finally(() => {
        state.tickInFlight = false;
      });
  };

  // Outbox sweeper — independent interval so file projection catches up
  // even when no rollouts are eligible.
  const sweepOutbox = (): void => {
    if (state.shutdownSignal || state.paused) return;
    try {
      const allowedRoots = deps.rootDir ? [deps.rootDir] : undefined;
      const n = drainOutbox(deps.memoryDb, { batchSize: 32, allowedRoots });
      if (n > 0) {
        logger.warn('MemoryWorkerOutbox', { drained: n }, LogComponent.DB);
      }
    } catch (err) {
      logger.warn(
        'MemoryWorkerOutbox failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }
  };

  // Curation sweeper — independent low-frequency timer (design §9.1 Hybrid
  // scheduler). The tick-level eager trigger only fires when a tick produced
  // new Stage 1 outputs; without a timer, ANY extraction outage (e.g. the
  // 2026-08-21..23 stretch where every extraction failed) also silently
  // disables Phase 2 while eligible inputs pile up. The quorum gate inside
  // curationTick makes idle sweeps cheap: an empty queue returns before any
  // LLM call, and the single-flight guard prevents overlap with an in-flight
  // cycle.
  const sweepCuration = (): void => {
    if (state.shutdownSignal || state.paused) return;
    curationTick({ force: false }).catch(() => { /* logged inside */ });
  };

  state.tickTimer = setInterval(tick, tickIntervalMs);
  state.outboxTimer = setInterval(sweepOutbox, cfg.sweepOutboxEveryMs);
  state.curationTimer = setInterval(sweepCuration, Math.max(1_000, cfg.consolidatorIntervalMs));
  // setInterval keeps the event loop alive; unref so the worker doesn't
  // block Electron shutdown on its own. Graceful shutdown is handled by
  // `performGracefulShutdown` calling `handle.shutdown()`.
  state.tickTimer.unref?.();
  state.outboxTimer.unref?.();
  state.curationTimer.unref?.();

  logger.warn(
    'MemoryWorker started',
    {
      workerId,
      tickIntervalMs,
      concurrency: cfg.concurrency,
      consolidatorIntervalMs: cfg.consolidatorIntervalMs,
      catalogSyncIntervalMs: cfg.catalogSyncIntervalMs,
      paused: state.paused,
    },
    LogComponent.DB,
  );

  const handleObj: MemoryWorkerHandle = {
    workerId,
    pause(): void {
      if (state.paused) return;
      state.paused = true;
      logger.warn('MemoryWorker paused', { workerId }, LogComponent.DB);
    },
    resume(): void {
      if (!state.paused) return;
      state.paused = false;
      logger.warn('MemoryWorker resumed', { workerId }, LogComponent.DB);
    },
    isPaused(): boolean {
      return state.paused;
    },
    async shutdown(): Promise<void> {
      if (state.shutdownSignal) return;
      state.shutdownSignal = true;
      if (state.tickTimer) {
        clearInterval(state.tickTimer);
        state.tickTimer = null;
      }
      if (state.outboxTimer) {
        clearInterval(state.outboxTimer);
        state.outboxTimer = null;
      }
      if (state.curationTimer) {
        clearInterval(state.curationTimer);
        state.curationTimer = null;
      }
      // Let in-flight extracts settle (best-effort; extractor's heartbeat
      // interval will be cleared by its own finally block). We do NOT abort
      // them — partial extraction progress is better than a dangling lease.
      if (state.inFlightExtracts.size > 0) {
        logger.warn(
          'MemoryWorker shutdown awaiting in-flight extracts',
          { count: state.inFlightExtracts.size, workerId },
          LogComponent.DB,
        );
        await Promise.allSettled([...state.inFlightExtracts]);
      }
      logger.warn('MemoryWorker shutdown complete', { workerId }, LogComponent.DB);
    },
    async forceSweep(): Promise<ForceSweepResult> {
      if (state.forceSweepInFlight) {
        // A second forceSweep during an in-flight sweep returns a zero-shaped
        // result so the IPC caller stays non-blocking.
        return {
          selected: 0,
          extracted: 0,
          skippedNoop: 0,
          outboxDrained: 0,
          reconciled: null,
          curated: null,
          catalogSynced: null,
          durationMs: 0,
        };
      }
      state.forceSweepInFlight = true;
      try {
        // forceSweep ignores the `paused` flag — it's a manual override.
        return await runTick({ force: true });
      } finally {
        state.forceSweepInFlight = false;
      }
    },
    /**
     * Test-only: run a non-forced curation tick so the Hybrid patience
     * trigger (N / T thresholds) can be verified without a forceSweep,
     * which always forces the cycle. Production code MUST NOT call this.
     */
    async curationTickForTest(): Promise<CurationTickResult> {
      return curationTick({ force: false });
    },
  };

  return handleObj;
}

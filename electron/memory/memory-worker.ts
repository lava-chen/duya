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
  DEFAULT_IDLE_MS,
  DEFAULT_WINDOW_MS,
} from '../../packages/agent/src/memory-state/eligibility.js';
import { drainOutbox } from '../../packages/agent/src/memory-state/outbox.js';
import { reconcileProjections } from '../../packages/agent/src/memory-state/reconcile.js';
import { queryEligibleInputs } from '../../packages/agent/src/memory-state/curation_ledger.js';
import { syncAllFromMainDb } from '../memory-state/catalogSync';
import { runCurationCycle, recoverAllPublications } from './curation_publish_orchestrator';
import { scanAdHocChanges } from './ad_hoc_watcher';
import type { AgentProcessPool } from '../agents/process-pool/agent-process-pool';
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
}

/**
 * Curation-cycle dependencies needed to drive `runCurationCycle` from the
 * memory worker (design §9.1 Hybrid scheduler). These are the same roots the
 * orchestration tests construct, but resolved at worker startup.
 */
export interface CurationWorkerDeps {
  /** Root that holds `stage1_policy.md` + `memory_layout.json` (memory-config). */
  configRoot: string;
  /** Root for `staging/<run_id>/` workspaces. */
  stagingRoot: string;
  /** Root for pre-publish snapshots. */
  snapshotRoot: string;
  /** LLM provider config forwarded to the curator agent process. */
  providerConfig: ProviderConfig;
  /** System location used as the agent's `init.workingDirectory`. */
  systemLocation: string;
  /** Agent process pool (shared with cron). */
  pool: AgentProcessPool;
}

export interface MemoryWorkerConfig {
  /** Tick frequency in invocations per minute. Default 60 (once per second). */
  instancesPerMinute: number;
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
  instancesPerMinute: 60,
  concurrency: 2,
  sweepOutboxEveryMs: 60_000,
  reconcileOnStart: true,
  paused: false,
  idleMs: DEFAULT_IDLE_MS,
  windowMs: DEFAULT_WINDOW_MS,
  consolidatorIntervalMs: 5 * 60_000, // 5 min
  consolidatorOnForceSweep: true,
  catalogSyncIntervalMs: 60_000, // 1 min
  extractCooldownMs: 120_000, // 2 min — space batches to avoid LLM rate-limit spikes
  minMessageCount: 6, // filter thin sessions
  projectCooldownMs: 10 * 60_000, // 10 min — suppress sibling extraction floods
};

// ---------------------------------------------------------------------------
// Phase 2 curation switch + Hybrid scheduler (Plan 406, design §9.1)
// ---------------------------------------------------------------------------

/**
 * Whether the Phase 2 curation cycle is active. Evaluated at call time so
 * tests can toggle `DUYA_MEMORY_PHASE2_ENABLED` between worker construction
 * and ticks. After Phase D (Task 11) the flag is default-on: the legacy
 * consolidator path is deleted, so the curation cycle is the only Phase 2
 * driver. Set `DUYA_MEMORY_PHASE2_ENABLED=0` to force it back off.
 */
function isPhase2Enabled(): boolean {
  const v = process.env.DUYA_MEMORY_PHASE2_ENABLED;
  if (v === '0' || v === 'false') return false;
  return true;
}

/** Fire the curation cycle when ≥ this many eligible inputs accumulate. */
const HYBRID_MIN_INPUTS = 3;
/** Or when the oldest eligible input has sat this long (30 min). */
const HYBRID_MAX_AGE_MS = 30 * 60_000;
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
 * Compute the Hybrid scheduler quorum from the two input axes (design §9.1):
 *   - rollout inputs: `queryEligibleInputs` (stage1_outputs not yet consumed)
 *   - ad-hoc inputs: `scanAdHocChanges` (files under extensions/ad_hoc/)
 *
 * Returns the total eligible count and the age (ms) of the oldest eligible
 * input. When nothing is eligible, oldestAgeMs is 0 so the T=30min trigger
 * cannot fire on an empty queue.
 */
async function curationQuorum(
  db: Database,
  memoryRoot: string,
): Promise<{ eligibleCount: number; oldestAgeMs: number }> {
  const now = Date.now();
  const rollout = queryEligibleInputs(db, {
    maxInputs: HYBRID_QUORUM_MAX_INPUTS,
    maxInputBytes: HYBRID_QUORUM_MAX_BYTES,
    now,
  });
  const adHoc = await scanAdHocChanges(db, path.join(memoryRoot, 'extensions', 'ad_hoc'));
  const all = [...rollout, ...adHoc];
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
  consolidatorTimer: ReturnType<typeof setInterval> | null;
  paused: boolean;
  tickInFlight: boolean;
  forceSweepInFlight: boolean;
  consolidatorInFlight: boolean;
  reconciledThisInstance: boolean;
  curationRecoveredThisInstance: boolean;
  inFlightExtracts: Set<Promise<unknown>>;
  shutdownSignal: boolean;
  lastCatalogSyncAt: number;
  lastExtractAt: number;
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
    consolidatorTimer: null,
    paused: cfg.paused,
    tickInFlight: false,
    forceSweepInFlight: false,
    consolidatorInFlight: false,
    reconciledThisInstance: false,
    curationRecoveredThisInstance: false,
    inFlightExtracts: new Set(),
    shutdownSignal: false,
    lastCatalogSyncAt: 0,
    lastExtractAt: 0,
  };

  const tickIntervalMs = Math.max(1_000, Math.floor(60_000 / Math.max(1, cfg.instancesPerMinute)));

  // Phase 2 curation cycle — single-flight Hybrid scheduler (design §9.1).
  // After Phase D (Task 11) the legacy `consolidatorTick` is deleted, so
  // this is the only Phase 2 driver. Applies the Hybrid trigger: force
  // always fires; otherwise N ≥ HYBRID_MIN_INPUTS eligible inputs OR the
  // oldest eligible input age ≥ HYBRID_MAX_AGE_MS.
  const curationTick = async (options: {
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

      const result = await runCurationCycle(deps.memoryDb, {
        memoryRoot,
        configRoot: curation.configRoot,
        stagingRoot: curation.stagingRoot,
        snapshotRoot: curation.snapshotRoot,
        providerConfig: curation.providerConfig,
        systemLocation: curation.systemLocation,
        workerId: state.workerId,
        pool: curation.pool,
        sessionId: `curation-${state.workerId}`,
      });
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
        const r = reconcileProjections(memoryDb, { rootDir, dryRun: false, now });
        reconciled = { written: r.written.length, removed: r.removed.length, mismatched: r.mismatched.length };
        logger.warn(
          'MemoryWorkerReconcile',
          { written: reconciled.written, removed: reconciled.removed, mismatched: reconciled.mismatched, durationMs: r.durationMs },
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

    // Phase 2 curation publication recovery (design §8.5). Runs once per
    // worker instance on the first non-paused tick (or any forceSweep).
    // Idempotent — `recoverAllPublications` is a no-op when no unfinished
    // journals exist. A recovery failure must not block the normal tick.
    if (
      isPhase2Enabled() &&
      deps.curation &&
      !state.curationRecoveredThisInstance &&
      (options.force || !state.paused)
    ) {
      state.curationRecoveredThisInstance = true;
      try {
        const recoverResult = await recoverAllPublications({
          stagingRoot: deps.curation.stagingRoot,
          liveMemoryRoot: deps.rootDir ?? path.join(os.homedir(), '.duya', 'memory'),
        });
        if (recoverResult.length > 0) {
          logger.warn(
            'MemoryWorkerCurationRecover',
            { recovered: recoverResult.length, actions: recoverResult.map((r) => r.action) },
            LogComponent.DB,
          );
        }
      } catch (err) {
        logger.warn(
          'MemoryWorkerCurationRecover failed',
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
        eligible = selectEligible(memoryDb, {
          now,
          limit: cfg.concurrency,
          idleMs: cfg.idleMs,
          windowMs: cfg.windowMs,
          minMessageCount: cfg.minMessageCount,
          projectCooldownMs: cfg.projectCooldownMs,
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
    let curated: CurationTickResult | null = null;
    if ((extracted > 0 || (options.force && cfg.consolidatorOnForceSweep)) && deps.curation) {
      curated = await curationTick({ force: options.force });
      // Drain again so the projection writes are flushed within the same
      // forceSweep window (useful for tests + IPC callers that expect files
      // on disk after forceSweep returns).
      if (curated?.ran) {
        try {
          const allowedRoots = deps.rootDir ? [deps.rootDir] : undefined;
          drainOutbox(memoryDb, { batchSize: 32, allowedRoots });
        } catch {
          // Best-effort; the outbox sweeper will catch up on its own.
        }
      }
    }

    const tickSummary = {
      selected: eligible.length,
      extracted,
      skippedNoop,
      outboxDrained,
      curated: curated?.ran ?? false,
      catalogSynced: catalogSynced ? (catalogSynced.inserted + catalogSynced.updated + catalogSynced.tombstoned) : 0,
      forced: options.force,
      durationMs: Date.now() - start,
    };

    // Log every tick at INFO for debugging; escalate to WARN when
    // something actually happened so operators can see activity.
    const hasActivity = extracted > 0 || outboxDrained > 0
      || (curated?.ran ?? false)
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
      curated,
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

  // Curation sweeper — independent interval so ad-hoc `.md` files dropped
  // into `extensions/ad_hoc/` are digested even when no Stage 1 extractions
  // are happening. The curation cycle's Hybrid trigger (N / T) fires here.
  const sweepConsolidator = (): void => {
    if (state.shutdownSignal || state.paused) return;
    if (!deps.curation) return;
    curationTick({ force: false }).catch(() => {
      // Already logged inside curationTick.
    });
  };

  state.tickTimer = setInterval(tick, tickIntervalMs);
  state.outboxTimer = setInterval(sweepOutbox, cfg.sweepOutboxEveryMs);
  state.consolidatorTimer = setInterval(sweepConsolidator, cfg.consolidatorIntervalMs);
  // setInterval keeps the event loop alive; unref so the worker doesn't
  // block Electron shutdown on its own. Graceful shutdown is handled by
  // `performGracefulShutdown` calling `handle.shutdown()`.
  state.tickTimer.unref?.();
  state.outboxTimer.unref?.();
  state.consolidatorTimer.unref?.();

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
      if (state.consolidatorTimer) {
        clearInterval(state.consolidatorTimer);
        state.consolidatorTimer = null;
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

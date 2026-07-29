/**
 * Memory v2 long-lived worker (Plan 305 Phase A + Plan 306 Phase B).
 *
 * Runs in the Electron main process. Owns a `setInterval` loop that
 * periodically:
 *   1. reconciles the file projection from DB (first tick only)
 *   2. selects eligible rollouts (`selectEligible`, limited to
 *      `concurrency` per tick)
 *   3. fires `Stage1Extractor.extract` for each, in parallel, via
 *      `Promise.allSettled` (one failing rollout does NOT kill the batch)
 *   4. drains the projection outbox (`drainOutbox`)
 *   5. runs the Phase 2 consolidator (`runConsolidator`) on a separate
 *      interval, and immediately after any tick that produced new
 *      Stage 1 outputs, so fresh extractions are promoted to canonical
 *      memory entries without waiting for the next sweep.
 *
 * Shadow mode (D1, revised by Plan 306 Phase B): the worker writes to
 * the memory-state DB and projection files under `~/.duya/memory`
 * (including global/ and projects/ Phase 2 projections). It never
 * touches `packages/agent/src/memory/` (the existing MemoryManager
 * path) — the agent read path still goes through MemoryManager until
 * Plan 306 Phase E flips the switch.
 *
 * Gated by `DUYA_MEMORY_V2_ENABLED` at the call site (electron/main.ts);
 * this module itself is import-safe and does nothing until
 * `startMemoryWorker` is called.
 */

import type { Database } from 'better-sqlite3';
import * as crypto from 'crypto';
import { getLogger, LogComponent } from '../logging/logger';
import type { LLMClient } from '../../packages/agent/src/llm/index.js';
import { Stage1Extractor } from '../../packages/agent/src/memory-rollout/extractor.js';
import {
  selectEligible,
  DEFAULT_IDLE_MS,
  DEFAULT_WINDOW_MS,
} from '../../packages/agent/src/memory-state/eligibility.js';
import { drainOutbox } from '../../packages/agent/src/memory-state/outbox.js';
import { reconcileProjections } from '../../packages/agent/src/memory-state/reconcile.js';
import {
  runConsolidator,
  type ConsolidatorResult,
} from '../../packages/agent/src/memory-state/consolidator.js';
import { syncAllFromMainDb } from '../memory-state/catalogSync';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MemoryWorkerDeps {
  /** Memory-state DB (must be bootstrapped + migrated before start). */
  memoryDb: Database;
  /** Main DUYA DB (read-only — used for catalog sync + message reads). */
  mainDb: Database;
  /** LLM client for Stage 1 extraction. */
  llmClient: LLMClient;
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
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
}

export interface ForceSweepResult {
  selected: number;
  extracted: number;
  skippedNoop: number;
  outboxDrained: number;
  reconciled: { written: number; removed: number; mismatched: number } | null;
  /** Phase 2 consolidator result; null when the consolidator was not run. */
  consolidated: ConsolidatorResult | null;
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
};

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
  inFlightExtracts: Set<Promise<unknown>>;
  shutdownSignal: boolean;
  lastCatalogSyncAt: number;
}

function createWorker(
  deps: MemoryWorkerDeps,
  cfg: MemoryWorkerConfig,
): MemoryWorkerHandle {
  const logger = getLogger();
  const workerId = `memory-worker-${crypto.randomUUID()}`;
  const extractor = new Stage1Extractor(deps.memoryDb, deps.mainDb, deps.llmClient, {
    rootDir: deps.rootDir,
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
    inFlightExtracts: new Set(),
    shutdownSignal: false,
    lastCatalogSyncAt: 0,
  };

  const tickIntervalMs = Math.max(1_000, Math.floor(60_000 / Math.max(1, cfg.instancesPerMinute)));

  // Phase 2 consolidator — single-flight wrapper around runConsolidator.
  // Returns null when a previous run is still in flight (the global lock
  // in phase2_runs would skip anyway, but this avoids a redundant
  // transaction). Logs the result for observability.
  const consolidatorTick = (options: {
    force: boolean;
  }): ConsolidatorResult | null => {
    if (state.consolidatorInFlight) return null;
    state.consolidatorInFlight = true;
    try {
      const result = runConsolidator({
        db: deps.memoryDb,
        rootDir: deps.rootDir,
      });
      if (!result.skipped) {
        logger.info(
          'MemoryWorkerConsolidator',
          {
            runId: result.runId,
            added: result.added,
            merged: result.merged,
            superseded: result.superseded,
            retired: result.retired,
            adHocDigested: result.adHocDigested,
            durationMs: result.durationMs,
            forced: options.force,
          },
          LogComponent.DB,
        );
      }
      return result;
    } catch (err) {
      logger.warn(
        'MemoryWorkerConsolidator failed',
        { error: err instanceof Error ? err.message : String(err), forced: options.force },
        LogComponent.DB,
      );
      return null;
    } finally {
      state.consolidatorInFlight = false;
    }
  };

  // The loop body. Shared between the interval tick and forceSweep.
  const runTick = async (options: {
    force: boolean;
  }): Promise<ForceSweepResult> => {
    const start = Date.now();
    const { memoryDb, mainDb, rootDir } = deps;
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
        logger.info(
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

    // Catalog sync: materialize chat_sessions from the main DB into
    // rollout_catalog. Throttled to catalogSyncIntervalMs on regular
    // ticks; always runs on forceSweep. Without this step, the catalog
    // stays empty and selectEligible returns nothing forever.
    let catalogSynced: ForceSweepResult['catalogSynced'] = null;
    const syncStale = now - state.lastCatalogSyncAt >= cfg.catalogSyncIntervalMs;
    if (options.force || syncStale) {
      try {
        const syncResult = syncAllFromMainDb({ mainDb, memoryDb });
        state.lastCatalogSyncAt = now;
        catalogSynced = {
          inserted: syncResult.inserted,
          updated: syncResult.updated,
          tombstoned: syncResult.tombstoned,
          errors: syncResult.errors,
        };
        if (syncResult.inserted > 0 || syncResult.updated > 0 || syncResult.tombstoned > 0) {
          logger.info(
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
    let eligible: ReturnType<typeof selectEligible> = [];
    try {
      eligible = selectEligible(memoryDb, {
        now,
        limit: cfg.concurrency,
        idleMs: cfg.idleMs,
        windowMs: cfg.windowMs,
      });
    } catch (err) {
      logger.warn(
        'MemoryWorkerSelectEligible failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }

    // Fire extracts in parallel; allSettled so one failure doesn't kill the batch.
    const extractPromises = eligible.map((r) =>
      state.extractor
        .extract({ rolloutId: r.rolloutId, claimedBy: workerId })
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

    // Phase 2 consolidator: run eagerly when this tick produced new
    // Stage 1 outputs (so fresh extractions are promoted without
    // waiting for the interval), or when forceSweep requests it.
    // The consolidator's own global lock + CAS-skip make this cheap
    // when there is nothing to do.
    let consolidated: ConsolidatorResult | null = null;
    if (extracted > 0 || (options.force && cfg.consolidatorOnForceSweep)) {
      consolidated = consolidatorTick({ force: options.force });
      // Drain again so the consolidator's projection writes are flushed
      // within the same forceSweep window (useful for tests + IPC
      // callers that expect files on disk after forceSweep returns).
      if (consolidated && !consolidated.skipped) {
        try {
          const allowedRoots = deps.rootDir ? [deps.rootDir] : undefined;
          drainOutbox(memoryDb, { batchSize: 32, allowedRoots });
        } catch {
          // Best-effort; the outbox sweeper will catch up on its own.
        }
      }
    }

    logger.info(
      'MemoryWorkerTick',
      {
        selected: eligible.length,
        extracted,
        skippedNoop,
        outboxDrained,
        consolidated: consolidated ? !consolidated.skipped : false,
        catalogSynced: catalogSynced ? (catalogSynced.inserted + catalogSynced.updated + catalogSynced.tombstoned) : 0,
        forced: options.force,
        durationMs: Date.now() - start,
      },
      LogComponent.DB,
    );

    return {
      selected: eligible.length,
      extracted,
      skippedNoop,
      outboxDrained,
      reconciled,
      consolidated,
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
        logger.info('MemoryWorkerOutbox', { drained: n }, LogComponent.DB);
      }
    } catch (err) {
      logger.warn(
        'MemoryWorkerOutbox failed',
        { error: err instanceof Error ? err.message : String(err) },
        LogComponent.DB,
      );
    }
  };

  // Consolidator sweeper — independent interval so ad-hoc `.md` files
  // dropped into `extensions/ad_hoc/` are digested even when no Stage 1
  // extractions are happening. The consolidator's own CAS-skip makes
  // this cheap when the input set is unchanged.
  const sweepConsolidator = (): void => {
    if (state.shutdownSignal || state.paused) return;
    consolidatorTick({ force: false });
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

  logger.info(
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
      logger.info('MemoryWorker paused', { workerId }, LogComponent.DB);
    },
    resume(): void {
      if (!state.paused) return;
      state.paused = false;
      logger.info('MemoryWorker resumed', { workerId }, LogComponent.DB);
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
        logger.info(
          'MemoryWorker shutdown awaiting in-flight extracts',
          { count: state.inFlightExtracts.size, workerId },
          LogComponent.DB,
        );
        await Promise.allSettled([...state.inFlightExtracts]);
      }
      logger.info('MemoryWorker shutdown complete', { workerId }, LogComponent.DB);
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
          consolidated: null,
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
  };

  return handleObj;
}

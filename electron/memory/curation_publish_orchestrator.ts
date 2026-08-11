import type { Database } from 'better-sqlite3';

import {
  queryEligibleInputs,
  claimRun,
  completeRun,
  failRun,
  abandonExpiredRuns,
  computeInputSetHash,
  type CurationInput,
  type InputDisposition,
} from '../../packages/agent/src/memory-state/curation_ledger';
import { runSingleShotCuration } from './curation_single_shot';
import { backupMemoryBeforeRun } from './memory_git_backup';
import { cleanStagingTmps } from './curation_file_writer';
import { refreshProjections } from './curation_projection_refresh';
import type { AIClient } from '@duya/ai';

/**
 * End-to-end curation cycle orchestrator (Plan 417 Task B).
 *
 * Flow:
 *   queryEligibleInputs → claimRun → git backup → cleanStagingTmps →
 *   runSingleShotCuration (non-streaming chat() + deterministic file
 *   writes) → completeRun with dispositions derived from the LLM's
 *   decisions.
 *
 * No more AgentProcessPool, no more curator profile, no more chat:done
 * IPC. The streaming curator hung at Turn 5-7 because M3 emits
 * `result` SSE without `message_stop` (see Plan 336 diagnosis). The
 * single-shot chat() path sidesteps that entirely.
 *
 * The legacy `pool: AgentProcessPool` parameter is kept for backward
 * compatibility with `MemoryWorkerDeps` but no longer used.
 */

import type { AgentProcessPool } from '../agents/process-pool/agent-process-pool';

const MIN_INPUTS_FOR_RUN = 2;
const MAX_INPUTS = 3;
const MAX_INPUT_BYTES = 512 * 1024;
/** Default single-shot curator wall-clock budget (ms). 4 minutes. */
const DEFAULT_CURATION_TIMEOUT_MS = 4 * 60_000;

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
}

export interface RunCurationCycleOpts {
  memoryRoot: string;
  configRoot: string;
  providerConfig: ProviderConfig;
  workerId: string;
  /** @deprecated unused by the single-shot path; kept for the call signature. */
  pool: AgentProcessPool;
  sessionId: string;
  /**
   * LLM client used for the single-shot chat() call. Required.
   */
  llmClient: AIClient;
  /**
   * Wall-clock budget (ms) for the single LLM call. Default 4 minutes.
   * Used both for the run lease TTL and the chat() deadline.
   */
  curationTimeoutMs?: number;
  now?: number;
}

export interface CycleResult {
  skipped: boolean;
  success: boolean;
  runId?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Run a single curation cycle. Returns the result of the cycle.
 *
 * The cycle is single-flight: if no eligible inputs meet the minimum
 * threshold, it returns `{ skipped: true }` without claiming a run.
 */
export async function runCurationCycle(
  db: Database,
  opts: RunCurationCycleOpts,
): Promise<CycleResult> {
  const startTime = Date.now();
  const now = opts.now ?? Date.now();
  const curationTimeoutMs = opts.curationTimeoutMs ?? DEFAULT_CURATION_TIMEOUT_MS;

  // Recover orphaned runs (expired lease while still 'running') before
  // claiming, so their pinned inputs become claimable again.
  abandonExpiredRuns(db, now);

  // Best-effort cleanup of stale .tmp files left behind by a crashed
  // prior cycle. Non-fatal.
  await cleanStagingTmps(opts.memoryRoot).catch(() => 0);

  // 1. Query eligible rollout inputs, oldest-first, truncated to MAX_INPUTS.
  const rolloutEligible = queryEligibleInputs(db, {
    maxInputs: MAX_INPUTS,
    maxInputBytes: MAX_INPUT_BYTES,
    now,
  });
  const claimed = rolloutEligible.map((e) => ({
    inputKind: e.inputKind,
    inputKey: e.inputKey,
    contentHash: e.contentHash,
    outputUpdatedAt: e.outputUpdatedAt,
  }));

  // 2. Skip if not enough inputs.
  if (claimed.length < MIN_INPUTS_FOR_RUN) {
    return { skipped: true, success: false };
  }

  // 3. Claim the run (single-flight).
  const inputSetHash = computeInputSetHash(claimed);
  const inputs: CurationInput[] = claimed.map((e) => ({
    inputKind: e.inputKind,
    inputKey: e.inputKey,
    contentHash: e.contentHash,
    outputUpdatedAt: e.outputUpdatedAt,
  }));

  let runId: string;
  try {
    const claim = claimRun(db, {
      inputSetHash,
      baseManifestHash: 'empty',
      claimedBy: opts.workerId,
      leaseTtlMs: curationTimeoutMs + 60_000,
      inputs,
      now,
    });
    runId = claim.runId;
  } catch (err) {
    // Single-flight: another run is in flight.
    return {
      skipped: true,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. Git-backup the live memory root so the run is rollback-safe.
  const backedUp = await backupMemoryBeforeRun(opts.memoryRoot, runId);
  if (!backedUp) {
    // Non-fatal — the file writer's path validation is the primary guard.
    void backedUp;
  }

  // 5. Run the single-shot curator (non-streaming chat + deterministic file
  // writes). The runner never throws — failures surface via RunResult.error
  // / RunResult.errors.
  const result = await runSingleShotCuration({
    memoryRoot: opts.memoryRoot,
    inputs: rolloutEligible.map((e) => ({
      inputKind: e.inputKind,
      inputKey: e.inputKey,
      contentHash: e.contentHash,
      outputUpdatedAt: e.outputUpdatedAt,
      rolloutSlug: e.rolloutSlug,
    })),
    llmClient: opts.llmClient,
    timeoutMs: curationTimeoutMs,
  });

  // 6. Mark claimed inputs according to the LLM's per-input decisions.
  // Defaults: when the LLM gave no decisions (parse failure / empty response),
  // fall back to `uncertain` so the inputs get retried on a later cycle.
  const dispositionByKey = new Map<string, 'absorbed' | 'no_signal' | 'uncertain'>();
  if (result.response !== null) {
    for (const d of result.response.decisions) {
      dispositionByKey.set(d.rollout_id, d.disposition);
    }
  }
  const dispositions: InputDisposition[] = inputs.map((i) => {
    const explicit = dispositionByKey.get(i.inputKey);
    const fallback: 'absorbed' | 'no_signal' | 'uncertain' =
      result.success && explicit === undefined ? 'absorbed' : explicit ?? 'uncertain';
    return {
      inputKind: i.inputKind,
      inputKey: i.inputKey,
      contentHash: i.contentHash,
      disposition: fallback,
    };
  });

  if (result.success) {
    // Refresh MEMORY.md / summary.md / index.md after a successful run.
    // Best-effort: failures here are logged but don't downgrade the run.
    try {
      const touched = await refreshProjections(opts.memoryRoot);
      if (touched.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[memory] refreshed ${touched.length} projection file(s)`);
      }
    } catch (err) {
      console.warn(
        '[memory] projection refresh failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    completeRun(db, runId, {
      dispositions,
      publicationStatus: 'succeeded',
      now: Date.now(),
    });
    return {
      skipped: false,
      success: true,
      runId,
      durationMs: Date.now() - startTime,
    };
  }

  // Partial or full failure — mark as failed. Inputs are still recorded
  // (with `uncertain` disposition) so the next cycle can pick them up.
  const errMsg =
    result.error ??
    (result.errors.length > 0
      ? `${result.errors.length} action(s) failed: ${result.errors[0].error}`
      : 'curation cycle failed without a top-level error');
  failRun(db, runId, `agent failed: ${errMsg}`, Date.now());
  completeRun(db, runId, {
    dispositions,
    publicationStatus: 'failed',
    now: Date.now(),
  });
  return {
    skipped: false,
    success: false,
    runId,
    error: `agent failed: ${errMsg}`,
    durationMs: Date.now() - startTime,
  };
}
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../agents/process-pool/agent-process-pool';

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
import { runCurationAgent } from './curation_agent_runner';
import { backupMemoryBeforeRun } from './memory_git_backup';

/**
 * End-to-end curation cycle orchestrator (simplified Phase 2 flow, 2026-08-09).
 *
 * Wires the direct flow:
 *   queryEligibleInputs → claimRun → git backup of the live memory root →
 *   run curator agent directly against the live memory root → completeRun
 *
 * No staging, snapshot, validation, or publication steps. The curator writes
 * validated memory files in place; the git backup is the rollback point.
 */

const MIN_INPUTS_FOR_RUN = 2;
const MAX_INPUTS = 3;
const MAX_INPUT_BYTES = 512 * 1024;
/** Default curator agent wall-clock budget (ms). 20 minutes. */
const DEFAULT_CURATION_TIMEOUT_MS = 1_200_000;

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
  pool: AgentProcessPool;
  sessionId: string;
  /**
   * Wall-clock budget (ms) for a single curator agent run. Used both for
   * the run lease TTL and the agent hard deadline. Default 20 minutes.
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
    // Non-fatal — the memory_write tool's format validation is the primary guard.
    void backedUp;
  }

  // 5. Run the curator agent directly against the live memory root.
  try {
    await runCurationAgent({
      pool: opts.pool,
      // Unique session per run: the curator must be an independent agent
      // instance (cronjob-style) with a fresh, empty message history. A
      // stable session id across runs made the agent accumulate persisted
      // tool_use/tool_result rounds, which (a) bloated context and drove
      // MiniMax-M3 into endless-thinking 20-min timeouts, and (b) forced
      // stale-message reconciliation that crashed the session with exit
      // code 1. Keying the session off runId gives each cycle a clean slate.
      sessionId: `${opts.sessionId}-${runId}`,
      memoryRoot: opts.memoryRoot,
      runId,
      // Pass the full eligible inputs (with rolloutSlug + generatedAt) so the
      // prompt builder can derive the real on-disk summary filenames.
      inputs: rolloutEligible,
      providerConfig: opts.providerConfig,
      timeoutMs: curationTimeoutMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failRun(db, runId, `agent failed: ${msg}`, Date.now());
    return {
      skipped: false,
      success: false,
      runId,
      error: `agent failed: ${msg}`,
      durationMs: Date.now() - startTime,
    };
  }

  // 6. Success — mark all claimed inputs as consumed (absorbed) so they are
  // not re-picked by queryEligibleInputs on a later run.
  const dispositions: InputDisposition[] = inputs.map((i) => ({
    inputKind: i.inputKind,
    inputKey: i.inputKey,
    contentHash: i.contentHash,
    disposition: 'absorbed' as const,
  }));
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

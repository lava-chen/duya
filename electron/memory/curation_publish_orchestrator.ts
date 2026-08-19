import type { Database } from 'better-sqlite3';
import type { AIClient } from '@duya/ai';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  queryEligibleInputs,
  claimRun,
  completeRun,
  failRun,
  abandonExpiredRuns,
  computeInputSetHash,
  countPriorDeferrals,
  type CurationInput,
  type InputDisposition,
} from '../../packages/agent/src/memory-state/curation_ledger';
import { runSingleShotCuration } from './curation_single_shot';
import { backupMemoryBeforeRun } from './memory_git_backup';
import { cleanStagingTmps } from './curation_file_writer';
import { refreshProjections } from './curation_projection_refresh';
import {
  computeCanonicalHash,
  synthesizeSummary,
  SYNTH_HASH_FILENAME,
} from './summary_synthesizer';
import { writeSystemLog } from '../../packages/agent/src/memory-state/system_log';
import type { RagRefreshResult } from './rag_index';

/**
 * End-to-end curation cycle orchestrator (Plan 417 Task B).
 *
 * Flow:
 *   queryEligibleInputs → claimRun → git backup → cleanStagingTmps →
 *   runSingleShotCuration (non-streaming chat() + deterministic file
 *   writes) → completeRun with dispositions derived from the LLM's
 *   decisions.
 *
 * No AgentProcessPool, no curator profile, no chat:done IPC. The
 * streaming curator hung at Turn 5-7 because M3 emits `result` SSE
 * without `message_stop` (see Plan 336 diagnosis). The single-shot
 * chat() path sidesteps that entirely.
 */

// Token budget control (Plan 417 follow-up): batch more inputs per run so
// the curator LLM is called less often. MIN_INPUTS_FOR_RUN 2 -> 3 avoids
// firing a call for a single thin pair of summaries.
const MIN_INPUTS_FOR_RUN = 3;
const MAX_INPUTS = 6;
const MAX_INPUT_BYTES = 512 * 1024;
/** Default single-shot curator wall-clock budget (ms). 4 minutes. */
const DEFAULT_CURATION_TIMEOUT_MS = 4 * 60_000;
/**
 * How long an 'uncertain' input waits before it becomes claimable again.
 * Uncertain means the curator could not decide safely; deferring (instead of
 * re-claiming every 30-min cycle) keeps it from pinning the Phase 2 loop.
 */
const DEFER_UNCERTAIN_MS = 60 * 60_000;
/**
 * Defer cap: after this many prior deferrals of the same
 * (input_key, content_hash), an 'uncertain' verdict is finalized as
 * 'no_signal' so the input can never pin the loop forever.
 */
const MAX_PRIOR_DEFERRALS = 2;

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
  /**
   * Post-run RAG index refresh (plan 428). Invoked with the memory root
   * after every successful cycle once all files are settled on disk.
   * Best-effort: failures are logged via the system log, never thrown.
   * Resolves the refresh result so the cycle can record it.
   */
  ragRefresh?: (memoryRoot: string) => Promise<RagRefreshResult | undefined>;
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
  const abandonedCount = abandonExpiredRuns(db, now);
  if (abandonedCount > 0) {
    writeSystemLog({
      phase: 'phase2',
      eventType: 'curation_run_abandoned',
      level: 'warn',
      message: `Recovered ${abandonedCount} orphaned curation run(s) with expired lease`,
      detail: { count: abandonedCount, now },
    });
  }

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

  writeSystemLog({
    phase: 'phase2',
    eventType: 'curation_run_started',
    message: `Curation run ${runId} claimed (${claimed.length} input(s))`,
    detail: {
      input_set_hash: inputSetHash,
      input_count: claimed.length,
      inputs: inputs.map((i) => i.inputKey),
    },
    runId,
    sessionId: opts.sessionId,
  });

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
      summaryMarkdown: e.summaryMarkdown,
    })),
    llmClient: opts.llmClient,
    timeoutMs: curationTimeoutMs,
    // Adaptive loop: curation may teach Stage 1 a new extraction focus.
    policyPath: path.join(opts.configRoot, 'stage1_policy.md'),
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
    if (explicit === 'uncertain') {
      // Defer instead of re-claiming every cycle so 'uncertain' inputs do
      // not pin the Phase 2 loop. Retried after DEFER_UNCERTAIN_MS — but
      // capped: after MAX_PRIOR_DEFERRALS deferrals of the same content,
      // finalize as 'no_signal' so it can never loop forever.
      const priorDeferrals = countPriorDeferrals(db, i.inputKey, i.contentHash);
      if (priorDeferrals >= MAX_PRIOR_DEFERRALS) {
        return {
          inputKind: i.inputKind,
          inputKey: i.inputKey,
          contentHash: i.contentHash,
          disposition: 'no_signal',
          note: `uncertain ${priorDeferrals + 1}x; defer cap reached, finalized as no_signal`,
        };
      }
      return {
        inputKind: i.inputKind,
        inputKey: i.inputKey,
        contentHash: i.contentHash,
        disposition: 'deferred',
        deferredUntil: Date.now() + DEFER_UNCERTAIN_MS,
      };
    }
    return {
      inputKind: i.inputKind,
      inputKey: i.inputKey,
      contentHash: i.contentHash,
      disposition: explicit ?? 'absorbed', // 'absorbed' | 'no_signal'
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
    writeSystemLog({
      phase: 'phase2',
      eventType: 'curation_run_succeeded',
      message: `Curation run ${runId} succeeded (${result.actionsApplied} action(s) applied)`,
      detail: {
        actions_applied: result.actionsApplied,
        policy_updated: result.policyUpdated ?? false,
        policy_version: result.policyVersion ?? 0,
        decisions: dispositions.map((d) => ({
          input_key: d.inputKey,
          disposition: d.disposition,
        })),
      },
      runId,
      sessionId: opts.sessionId,
    });

    // Log each canonical file change so the user can see which files Phase 2
    // touched and what was added, grouped under this run.
    if (result.response?.actions) {
      for (const action of result.response.actions) {
        if (action.op === 'no_op') continue;
        writeSystemLog({
          phase: 'phase2',
          eventType: 'curation_file_changed',
          message: `${action.op === 'replace' ? 'Replaced' : 'Appended to'} ${action.area_path}`,
          detail: {
            op: action.op,
            area_path: action.area_path,
            reason: action.reason ?? null,
            content_preview: (action.content ?? '').slice(0, 200),
          },
          runId,
          sessionId: opts.sessionId,
        });
      }
    }

    // Log any stage1_policy / new-category side effects from this run.
    if (result.policyUpdated) {
      writeSystemLog({
        phase: 'phase2',
        eventType: 'curation_policy_updated',
        message: `stage1_policy updated to v${result.policyVersion}`,
        detail: { policy_version: result.policyVersion ?? 0 },
        runId,
        sessionId: opts.sessionId,
      });
    }

    // Phase 3 — semantic summary synthesis. Hash-gated: only re-runs when
    // the canonical store actually changed, so a busy curation loop never
    // re-summarizes unchanged memory. Best-effort: `synthesizeSummary`
    // always returns a deterministic fallback on failure, so summary.md
    // is never stale.
    try {
      const canonicalHash = await computeCanonicalHash(opts.memoryRoot);
      const sidecarPath = path.join(opts.memoryRoot, SYNTH_HASH_FILENAME);
      let prevHash: string | null = null;
      try {
        prevHash = (await fs.readFile(sidecarPath, 'utf8')).trim();
      } catch {
        prevHash = null; // no sidecar yet — first synthesis
      }
      if (prevHash === canonicalHash) {
        // No substantive change since the last synthesis — skip the LLM call.
      } else {
        const synth = await synthesizeSummary({
          memoryRoot: opts.memoryRoot,
          llmClient: opts.llmClient,
          timeoutMs: curationTimeoutMs,
        });
        await fs.writeFile(path.join(opts.memoryRoot, 'summary.md'), synth.content, 'utf8');
        await fs.writeFile(sidecarPath, canonicalHash, 'utf8');
        if (synth.success) {
          writeSystemLog({
            phase: 'phase3',
            eventType: 'summary_synthesized',
            message: 'Semantic summary synthesized (Phase 3)',
            detail: { bytes: synth.content.length },
            runId,
            sessionId: opts.sessionId,
          });
        } else {
          writeSystemLog({
            phase: 'phase3',
            eventType: 'summary_synthesis_fallback',
            level: 'warn',
            message: `Semantic summary synthesis fell back to deterministic index (${synth.error ?? 'unknown'})`,
            detail: { error: synth.error ?? null },
            runId,
            sessionId: opts.sessionId,
          });
        }
      }
    } catch (err) {
      writeSystemLog({
        phase: 'phase3',
        eventType: 'summary_synthesis_failed',
        level: 'warn',
        message: 'Semantic summary synthesis failed',
        detail: { error: err instanceof Error ? err.message : String(err) },
        runId,
        sessionId: opts.sessionId,
      });
    }

    // Phase 4 — RAG index refresh (plan 428). Runs after every successful
    // cycle, once canonical files, projections, and summary.md are all on
    // disk. Best-effort: a refresh failure never downgrades the run.
    if (opts.ragRefresh) {
      try {
        const result = await opts.ragRefresh(opts.memoryRoot);
        writeSystemLog({
          phase: 'phase3',
          eventType: 'rag_index_refreshed',
          level: 'info',
          message: 'RAG index refreshed after curation run',
          detail: result
            ? {
                documents: result.documents,
                embedded: result.embedded,
                scanRoots: result.scanRoots,
                durationMs: result.durationMs,
              }
            : { documents: 0, embedded: 0 },
          runId,
          sessionId: opts.sessionId,
        });
      } catch (err) {
        writeSystemLog({
          phase: 'phase3',
          eventType: 'rag_index_refresh_failed',
          level: 'warn',
          message: 'RAG index refresh failed after curation run',
          detail: { error: err instanceof Error ? err.message : String(err) },
          runId,
          sessionId: opts.sessionId,
        });
      }
    }

    return {
      skipped: false,
      success: true,
      runId,
      durationMs: Date.now() - startTime,
    };
  }

  // Partial or full failure — mark the run failed. `failRun` leaves the
  // claimed inputs with `disposition = NULL`, so `queryEligibleInputs`
  // re-picks them on the next cycle. We must NOT call `completeRun` here:
  // it requires status='running' and would throw after failRun flipped it.
  const errMsg =
    result.error ??
    (result.errors.length > 0
      ? `${result.errors.length} action(s) failed: ${result.errors[0].error}`
      : 'curation cycle failed without a top-level error');
  failRun(db, runId, `agent failed: ${errMsg}`, Date.now());
  writeSystemLog({
    phase: 'phase2',
    eventType: 'curation_run_failed',
    level: 'error',
    message: `Curation run ${runId} failed (${errMsg})`,
    detail: { error: errMsg, action_errors: result.errors },
    runId,
    sessionId: opts.sessionId,
  });
  return {
    skipped: false,
    success: false,
    runId,
    error: `agent failed: ${errMsg}`,
    durationMs: Date.now() - startTime,
  };
}
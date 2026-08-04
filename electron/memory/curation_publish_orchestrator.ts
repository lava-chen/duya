import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../agents/process-pool/agent-process-pool';

import {
  queryEligibleInputs,
  claimRun,
  completeRun,
  failRun,
  computeInputSetHash,
  type CurationInput,
  type InputDisposition,
} from '../../packages/agent/src/memory-state/curation_ledger';
import { createStaging, deleteStaging } from './curation_staging';
import { runCurationAgent, type RunCurationAgentResult } from './curation_agent_runner';
import { validateStaging } from '../../packages/agent/src/memory-state/curation_validator';
import { preparePublication, executePublication, recoverPublication, type RecoveryAction } from './curation_publisher';
import { createSnapshot } from './curation_snapshot';
import { appendHealthReport, type HealthReport } from '../../packages/agent/src/memory-state/curation_health';
import { scanAdHocChanges, type AdHocInput } from './ad_hoc_watcher';

/**
 * End-to-end curation cycle orchestrator (design §8.4 + §9.1).
 *
 * Wires the full flow:
 *   queryEligibleInputs → claimRun → createStaging → runCurationAgent →
 *   validateStaging → createSnapshot → preparePublication →
 *   executePublication → completeRun → appendHealthReport → deleteStaging
 *
 * During Phase B shadow, the caller sets `shadowMode=true` which skips
 * the snapshot/publish/complete steps and discards staging after
 * validation — no live memory writes occur.
 */

const MIN_INPUTS_FOR_RUN = 3;
const MAX_INPUTS = 8;
const MAX_INPUT_BYTES = 512 * 1024;
const AGENT_TIMEOUT_MS = 600_000; // 10 minutes

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
}

export interface RunCurationCycleOpts {
  memoryRoot: string;
  configRoot: string;
  stagingRoot: string;
  snapshotRoot: string;
  providerConfig: ProviderConfig;
  systemLocation: string;
  workerId: string;
  pool: AgentProcessPool;
  sessionId: string;
  now?: number;
  shadowMode?: boolean;
}

export interface CycleResult {
  skipped: boolean;
  success: boolean;
  runId?: string;
  error?: string;
  durationMs?: number;
}

/**
 * A single input claimed for a curation run, normalized across rollout
 * and ad-hoc sources. `sourcePath` is the absolute path used to freeze
 * the input's evidence into the staging workspace.
 */
interface ClaimedInput {
  inputKind: 'rollout' | 'ad_hoc';
  inputKey: string;
  contentHash: string;
  outputUpdatedAt: number;
  sourcePath: string;
}

/**
 * Run a single curation cycle. Returns the result of the cycle.
 *
 * The cycle is single-flight: if no eligible inputs meet the minimum
 * threshold (and no timeout), it returns `{ skipped: true }` without
 * claiming a run.
 */
export async function runCurationCycle(
  db: Database,
  opts: RunCurationCycleOpts,
): Promise<CycleResult> {
  const startTime = Date.now();
  const now = opts.now ?? Date.now();

  // 1. Query eligible inputs (rollout + ad-hoc), merged and truncated.
  const rolloutEligible = queryEligibleInputs(db, {
    maxInputs: MAX_INPUTS,
    maxInputBytes: MAX_INPUT_BYTES,
    now,
  });
  const adHocEligible: AdHocInput[] = await scanAdHocChanges(
    db,
    path.join(opts.memoryRoot, 'extensions', 'ad_hoc'),
  );

  const rolloutClaimed: ClaimedInput[] = rolloutEligible.map((e) => ({
    inputKind: e.inputKind,
    inputKey: e.inputKey,
    contentHash: e.contentHash,
    outputUpdatedAt: e.outputUpdatedAt,
    sourcePath: path.join(opts.memoryRoot, 'rollout_summaries', `${e.inputKey}.md`),
  }));
  const adHocClaimed: ClaimedInput[] = adHocEligible.map((e) => ({
    inputKind: e.inputKind,
    inputKey: e.inputKey,
    contentHash: e.contentHash,
    outputUpdatedAt: e.outputUpdatedAt,
    sourcePath: e.sourcePath,
  }));

  // Merge both sources, oldest-first, then truncate to MAX_INPUTS.
  const claimed = [...rolloutClaimed, ...adHocClaimed]
    .sort((a, b) => a.outputUpdatedAt - b.outputUpdatedAt)
    .slice(0, MAX_INPUTS);

  // 2. Skip if not enough inputs.
  if (claimed.length < MIN_INPUTS_FOR_RUN) {
    return { skipped: true, success: false };
  }

  // 3. Claim the run.
  const inputSetHash = computeInputSetHash(claimed);
  const baseManifestHash = computeLiveManifestHash(opts.memoryRoot);
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
      baseManifestHash,
      claimedBy: opts.workerId,
      leaseTtlMs: AGENT_TIMEOUT_MS + 60_000,
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

  let stagingDir: string | null = null;

  try {
    // 4. Create staging workspace.
    const stagingResult = await createStaging(opts.stagingRoot, runId, {
      memoryRoot: opts.memoryRoot,
      configRoot: opts.configRoot,
      inputs: claimed.map((e) => ({
        inputKind: e.inputKind,
        inputKey: e.inputKey,
        contentHash: e.contentHash,
        sourcePath: e.sourcePath,
      })),
    });
    stagingDir = stagingResult.stagingDir;

    // 5. Run the curation agent.
    let agentResult: RunCurationAgentResult;
    try {
      agentResult = await runCurationAgent({
        pool: opts.pool,
        sessionId: opts.sessionId,
        stagingDir,
        runId,
        inputs,
        providerConfig: opts.providerConfig,
        systemLocation: opts.systemLocation,
        timeoutMs: AGENT_TIMEOUT_MS,
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

    // 6. Validate staging (async — runs receipt + canonical + security checks).
    const validation = await validateStaging(stagingDir, inputs);

    if (!validation.valid) {
      const errorMsg = validation.errors.join('; ');
      failRun(db, runId, `validation failed: ${errorMsg}`, Date.now());
      return {
        skipped: false,
        success: false,
        runId,
        error: `validation failed: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 7. Shadow mode: stop here, discard staging.
    if (opts.shadowMode) {
      return {
        skipped: false,
        success: true,
        runId,
        durationMs: Date.now() - startTime,
      };
    }

    // 8. Create pre-publish snapshot.
    await createSnapshot({
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
      snapshotRoot: opts.snapshotRoot,
    });

    // 9. Prepare publication.
    const journal = await preparePublication({
      runId,
      stagingDir,
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
      oldManifestHash: baseManifestHash,
      generation: extractCurrentGeneration(opts.memoryRoot) + 1,
    });

    // 10. Execute publication.
    await executePublication(journal, {
      stagingDir,
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
    });

    // 11. Complete the run in the ledger.
    const dispositions: InputDisposition[] = agentResult.receipt?.inputs?.map((i) => ({
      inputKind: i.input_kind === 'ad_hoc' ? 'ad_hoc' : 'rollout',
      inputKey: i.input_key,
      contentHash: i.content_hash,
      disposition: i.disposition as InputDisposition['disposition'],
      note: i.note,
    })) ?? [];

    completeRun(db, runId, {
      dispositions,
      publicationStatus: 'succeeded',
      now: Date.now(),
    });

    // 12. Append health report.
    const health: HealthReport = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      inputs: inputs.length,
      added: agentResult.receipt?.health?.added ?? 0,
      merged: agentResult.receipt?.health?.merged ?? 0,
      retired: agentResult.receipt?.health?.retired ?? 0,
      no_change: agentResult.receipt?.health?.no_change ?? 0,
      rejected: agentResult.receipt?.health?.rejected ?? 0,
      duplicate_rate: inputs.length > 0
        ? (agentResult.receipt?.health?.rejected ?? 0) / inputs.length
        : 0,
      memory_md_size: fs.existsSync(path.join(opts.memoryRoot, 'MEMORY.md'))
        ? fs.statSync(path.join(opts.memoryRoot, 'MEMORY.md')).size
        : 0,
      summary_md_size: fs.existsSync(path.join(opts.memoryRoot, 'summary.md'))
        ? fs.statSync(path.join(opts.memoryRoot, 'summary.md')).size
        : 0,
      entity_files: countEntityFiles(opts.memoryRoot),
      policy_version: null,
      layout_version: null,
    };
    appendHealthReport(opts.snapshotRoot, health);

    return {
      skipped: false,
      success: true,
      runId,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // 13. Clean up staging.
    if (stagingDir) {
      await deleteStaging(stagingDir);
    }
  }
}

// ---------------------------------------------------------------------------
// recoverAllPublications (design §8.5)
// ---------------------------------------------------------------------------

export interface RecoveryScanResult {
  runId: string;
  action: RecoveryAction;
}

export interface RecoverAllOpts {
  stagingRoot: string;
  liveMemoryRoot: string;
}

/**
 * Scan all staging directories for unfinished publication journals and
 * recover them. Called on memory-worker startup (design §8.5).
 *
 * For each `stagingRoot/<run_id>/publication.journal.json` found:
 *   1. Call `recoverPublication` to determine + perform the recovery action
 *   2. Record the result
 *
 * Returns a list of recovery results, one per journal found.
 */
export async function recoverAllPublications(opts: RecoverAllOpts): Promise<RecoveryScanResult[]> {
  if (!fs.existsSync(opts.stagingRoot)) return [];

  const results: RecoveryScanResult[] = [];

  const entries = fs.readdirSync(opts.stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const stagingDir = path.join(opts.stagingRoot, entry.name);
    const journalPath = path.join(stagingDir, 'publication.journal.json');

    if (!fs.existsSync(journalPath)) continue;

    const recovery = await recoverPublication(journalPath, opts.liveMemoryRoot);

    results.push({
      runId: recovery.runId ?? entry.name,
      action: recovery.action,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeLiveManifestHash(memoryRoot: string): string {
  const manifestPath = path.join(memoryRoot, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  return 'empty';
}

function extractCurrentGeneration(memoryRoot: string): number {
  const manifestPath = path.join(memoryRoot, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return manifest.generation ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function countEntityFiles(memoryRoot: string): number {
  const entitiesDir = path.join(memoryRoot, 'entities');
  if (!fs.existsSync(entitiesDir)) return 0;
  let count = 0;
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        count++;
      }
    }
  }
  walk(entitiesDir);
  return count;
}
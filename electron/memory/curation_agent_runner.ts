/**
 * Curation agent runner (Memory Phase 2 redesign, design §8.4 step 4-5).
 *
 * Acquires a process from the agent process pool, drives the curator
 * agent (init + chat:start with the curator system prompt, profile, and
 * root-bound tool allowlist), waits for `chat:done` or a timeout, then
 * `releaseAndWait`s the pool slot and reads `curation_receipt.json`.
 *
 * The runner does NOT publish — it returns the receipt for the worker
 * to validate (Plan 403's `validateStaging`) and publish (Plan 404).
 *
 * Design: docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md
 *   §7.4  — session identity (mode='automation', exclude_from_stage1=true)
 *   §8.4  — step 4 (acquire pool) + step 5 (run agent, timeout 10min)
 *   §9.2  — releaseAndWait before deleting staging
 *   §12   — curation_receipt.json is mandatory
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CURATOR_SYSTEM_PROMPT, buildCuratorInitialMessage, type RunInput } from '@duya/agent';

// Local minimal shapes for the IPC messages we send (the runtime messages
// are plain objects serialized over IPC; we do not need the full
// worker-protocol type surface in the runner, and `@duya/agent` does not
// export that subpath).
interface ProviderConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'ollama';
  authStyle?: 'api_key' | 'auth_token';
  visionConfig?: {
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    enabled: boolean;
  };
}

interface InitCommand {
  type: 'init';
  sessionId: string;
  providerConfig: ProviderConfig;
  workingDirectory?: string;
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
}

interface ChatStartCommand {
  type: 'chat:start';
  sessionId: string;
  id: string;
  prompt: string;
  options: {
    systemPrompt?: string;
    allowedTools?: string[];
    agentProfileId?: string | null;
    mode?: string;
    excludeFromStage1?: boolean;
  };
}

/**
 * The pool surface the runner depends on. This is a structural interface
 * (duck-typed) so tests can inject a mock without subclassing
 * AgentProcessPool.
 */
export interface CurationRunnerPool {
  acquire(sessionId: string): Promise<{ isNew: boolean }>;
  send(sessionId: string, msg: Record<string, unknown>): boolean;
  onMessage(sessionId: string, handler: (msg: { type: string; [k: string]: unknown }) => void): void;
  removeMessageHandler(sessionId: string, handler?: (msg: { type: string; [k: string]: unknown }) => void): void;
  releaseAndWait(sessionId: string, opts?: { gracefulMs?: number }): Promise<void>;
}

/**
 * Receipt shape read from stagingDir/curation_receipt.json. Mirrors
 * CurationReceipt from curation_validator.ts but defined here so the
 * Electron runner does not need to import the validator (the worker
 * validates; the runner just collects).
 */
export interface RunnerReceipt {
  run_id: string;
  inputs: Array<{
    input_kind: string;
    input_key: string;
    content_hash: string;
    disposition: string;
    note?: string;
  }>;
  files_changed: string[];
  policy_proposal?: string | null;
  layout_changed: boolean;
  health: {
    added: number;
    merged: number;
    retired: number;
    no_change: number;
    rejected: number;
  };
}

export interface RunCurationAgentOpts {
  /** Pool handle (the real AgentProcessPool or a mock). */
  pool: CurationRunnerPool;
  /** Session id to acquire under. Must be dedicated to this curation run. */
  sessionId: string;
  /**
   * Run-specific staging directory (stagingRoot/<run_id>/). Must already
   * exist (created by `createStaging` from Plan 402). Contains memory/,
   * memory-config/, inputs/, and is where curation_receipt.json must
   * land.
   */
  stagingDir: string;
  /** Curation run id — surfaced in the initial message so the agent can echo it in the receipt. */
  runId: string;
  /** Inputs claimed for this run (from `curation_ledger.claimRun`). */
  inputs: RunInput[];
  /** LLM provider config (forwarded to the agent process via `init`). */
  providerConfig: ProviderConfig;
  /**
   * System location — maps to `init.workingDirectory`. The curator's
   * root-bound tools ignore this (they are bound to stagingDir), but
   * the agent process needs a valid workingDirectory to initialize.
   */
  systemLocation: string;
  /** Wall-clock timeout for the agent run. Default 10 min (design §8.4 step 5). */
  timeoutMs?: number;
  /** gracefulMs for releaseAndWait. Default 10_000 (design §9.2). */
  gracefulMs?: number;
  /** Optional browserBackendMode forwarded to init (default 'auto'). */
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
}

export interface RunCurationAgentResult {
  receipt: RunnerReceipt;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (design §8.4 step 5)
const DEFAULT_GRACEFUL_MS = 10_000; // 10 seconds (design §9.2)

/**
 * Run the curator agent end-to-end:
 *   1. pool.acquire(sessionId)
 *   2. send `init` (providerConfig + workingDirectory=systemLocation)
 *   3. send `chat:start` with:
 *        - systemPrompt = CURATOR_SYSTEM_PROMPT
 *        - allowedTools = ['read','write','edit','grep','glob']
 *        - agentProfileId = 'memory-curator'
 *        - mode = 'automation'
 *        - excludeFromStage1 = true (design §7.4)
 *        - prompt = buildCuratorInitialMessage(stagingDir, inputs, runId)
 *   4. race `chat:done` (resolve) / `chat:error` (reject) / timeout (reject)
 *   5. finally: releaseAndWait(sessionId, { gracefulMs })
 *   6. read stagingDir/curation_receipt.json — reject if missing (design §12)
 *
 * The runner does NOT validate the receipt — the worker calls
 * `validateStaging` after this returns. The runner only collects.
 */
export async function runCurationAgent(opts: RunCurationAgentOpts): Promise<RunCurationAgentResult> {
  const {
    pool,
    sessionId,
    stagingDir,
    runId,
    inputs,
    providerConfig,
    systemLocation,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    gracefulMs = DEFAULT_GRACEFUL_MS,
    browserBackendMode = 'auto',
  } = opts;

  const start = Date.now();

  await pool.acquire(sessionId);

  try {
    // 1. init
    const initMsg: InitCommand = {
      type: 'init',
      sessionId,
      providerConfig,
      workingDirectory: systemLocation,
      browserBackendMode,
      // No skillPaths, no AGENTS.md injection — curator runs headless
      // with the 5 root-bound tools only (design §7.3).
    };
    pool.send(sessionId, initMsg as unknown as Record<string, unknown>);

    // 2. chat:start with curator options.
    const prompt = buildCuratorInitialMessage(stagingDir, inputs, runId);
    const startMsg: ChatStartCommand = {
      type: 'chat:start',
      sessionId,
      id: runId,
      prompt,
      options: {
        systemPrompt: CURATOR_SYSTEM_PROMPT,
        allowedTools: ['read', 'write', 'edit', 'grep', 'glob'],
        agentProfileId: 'memory-curator',
        mode: 'automation',
        excludeFromStage1: true,
      },
    };
    pool.send(sessionId, startMsg as unknown as Record<string, unknown>);

    // 3. Wait for chat:done / chat:error / timeout.
    await waitForAgentCompletion(pool, sessionId, timeoutMs);
  } finally {
    // 4. releaseAndWait — hard boundary before staging cleanup (design §9.2).
    await pool.releaseAndWait(sessionId, { gracefulMs });
  }

  // 5. Read receipt (design §12 — mandatory even for no-op curation).
  const receiptPath = path.join(stagingDir, 'curation_receipt.json');
  if (!fs.existsSync(receiptPath)) {
    throw new Error(
      `curation_receipt.json not found at ${receiptPath} — agent did not emit a receipt (design §12)`,
    );
  }
  let receiptRaw: string;
  try {
    receiptRaw = fs.readFileSync(receiptPath, 'utf-8');
  } catch (e) {
    throw new Error(`could not read curation_receipt.json: ${(e as Error).message}`);
  }
  let receipt: RunnerReceipt;
  try {
    receipt = JSON.parse(receiptRaw) as RunnerReceipt;
  } catch (e) {
    throw new Error(`curation_receipt.json is not valid JSON: ${(e as Error).message}`);
  }

  return {
    receipt,
    durationMs: Date.now() - start,
  };
}

/**
 * Wait for the agent to signal completion. Resolves on `chat:done`,
 * rejects on `chat:error` or timeout. Always removes the message
 * handler before returning (no listener leak).
 */
function waitForAgentCompletion(
  pool: CurationRunnerPool,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handler = (msg: { type: string; message?: string; code?: string }): void => {
      if (msg.type === 'chat:done') {
        cleanup();
        resolve();
      } else if (msg.type === 'chat:error') {
        cleanup();
        reject(new Error(`curator agent error: ${msg.message ?? 'unknown'}${msg.code ? ` (code=${msg.code})` : ''}`));
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`curator agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Do not keep the event loop alive just for the timeout.
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      pool.removeMessageHandler(sessionId, handler);
    }

    pool.onMessage(sessionId, handler);
  });
}
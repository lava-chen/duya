/**
 * Curation agent runner (simplified Phase 2 flow, 2026-08-09).
 *
 * Acquires a process from the agent process pool, drives the curator agent
 * (init + chat:start with the curator system prompt, profile, and a curated
 * tool allowlist), and waits for `chat:done` or a timeout, then
 * `releaseAndWait`s the pool slot. The curator works DIRECTLY on the live
 * memory root (no staging), so there is no receipt to collect — success is
 * signalled purely by `chat:done`.
 */

import { CURATOR_SYSTEM_PROMPT, buildCuratorInitialMessage, type RunInput } from '@duya/agent';
import { resolveDefaultBaseURL } from '@duya/ai';

/**
 * Race `fn` against a hard wall-clock deadline. Guarantees the returned
 * promise always settles (resolves or rejects) within `timeoutMs`, even
 * if `fn` itself hangs (e.g. `pool.acquire` blocks before the inner
 * completion timer is armed). The timer is NOT unref'd so it always fires.
 */
function withHardDeadline<T>(fn: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

// Local minimal shapes for the IPC messages we send (the runtime messages
// are plain objects serialized over IPC; we do not need the full
// worker-protocol type surface in the runner, and `@duya/agent` does not
// export that subpath).
interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  provider: string;
  authStyle?: 'api_key' | 'auth_token';
  visionConfig?: {
    provider: string;
    model: string;
    baseURL: string;
    apiKey: string;
    enabled: boolean;
  };
}

/**
 * The provider-config shape the agent subprocess init protocol expects. Note
 * the field is `baseURL` (uppercase), unlike the runner's input `ProviderConfig`
 * which uses `baseUrl` (lowercase). The runner normalizes one into the other
 * before sending init to the agent.
 */
interface AgentProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: string;
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
  providerConfig: AgentProviderConfig;
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
    permissionModeOverride?: 'default' | 'auto' | 'bypassPermissions';
    /**
     * Reasoning effort. The curator sets `'off'` so MiniMax-M3 does not
     * enter adaptive-thinking mode: with adaptive thinking enabled (the
     * default when effort is undefined) MiniMax can emit a near-infinite
     * thinking stream that never converges and hangs the whole run budget.
     * Disabling it makes the curator respond quickly and reliably.
     */
    effort?: string;
    /**
     * Wall-clock timeout (ms) for a single LLM request inside the curator
     * turn. The agent aborts a single LLM call that overruns this even
     * while the stream is still producing data (e.g. a MiniMax thinking
     * stream that never converges), so a hung final-answer call fails the
     * run fast instead of burning the whole run budget.
     */
    llmRequestTimeoutMs?: number;
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
  /**
   * Override the pool's heartbeat health-check timeout (ms) for this session
   * (or `null` to clear). The pool's default 120s would otherwise kill a
   * legitimately long curation run; the runner's own deadline governs instead.
   */
  setSessionHeartbeatTimeout(sessionId: string, ms: number | null): void;
}

export interface RunCurationAgentOpts {
  /** Pool handle (the real AgentProcessPool or a mock). */
  pool: CurationRunnerPool;
  /** Session id to acquire under. Must be dedicated to this curation run. */
  sessionId: string;
  /**
   * Live memory root directory (~/.duya/memory). The curator works directly
   * here (no staging). Passed as `init.workingDirectory` and as the root for
   * `buildCuratorInitialMessage`.
   */
  memoryRoot: string;
  /** Curation run id — surfaced in the initial message. */
  runId: string;
  /** Inputs claimed for this run (from `curation_ledger.claimRun`). */
  inputs: RunInput[];
  /** LLM provider config (forwarded to the agent process via `init`). */
  providerConfig: ProviderConfig;
  /** Wall-clock timeout for the agent run. Default 20 min. */
  timeoutMs?: number;
  /** gracefulMs for releaseAndWait. Default 10_000. */
  gracefulMs?: number;
  /** Optional browserBackendMode forwarded to init (default 'auto'). */
  browserBackendMode?: 'auto' | 'extension' | 'built-in' | 'human-like';
}

export interface RunCurationAgentResult {
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_GRACEFUL_MS = 10_000; // 10 seconds

/**
 * Run the curator agent end-to-end:
 *   1. pool.acquire(sessionId)
 *   2. send `init` (providerConfig + workingDirectory=memoryRoot)
 *   3. send `chat:start` with:
 *        - systemPrompt = CURATOR_SYSTEM_PROMPT
 *        - allowedTools = ['read','grep','glob','memory_write','write_stage1_policy']
 *        - agentProfileId = 'memory-curator'
 *        - mode = 'automation'
 *        - excludeFromStage1 = true
 *        - permissionModeOverride = 'bypassPermissions' (headless, no ask)
 *        - prompt = buildCuratorInitialMessage(memoryRoot, inputs, runId)
 *   4. race `chat:done` (resolve) / `chat:error` (reject) / timeout (reject)
 *   5. finally: releaseAndWait(sessionId, { gracefulMs })
 */
export async function runCurationAgent(opts: RunCurationAgentOpts): Promise<RunCurationAgentResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withHardDeadline(runInner(opts), timeoutMs + 30_000, 'curation agent');
}

async function runInner(opts: RunCurationAgentOpts): Promise<RunCurationAgentResult> {
  const {
    pool,
    sessionId,
    memoryRoot,
    runId,
    inputs,
    providerConfig,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    gracefulMs = DEFAULT_GRACEFUL_MS,
    browserBackendMode = 'auto',
  } = opts;

  const start = Date.now();

  await pool.acquire(sessionId);

  // Extend the pool's heartbeat health-check so a legitimately long curation
  // run (up to timeoutMs) is not killed by the pool's default 120s timeout.
  pool.setSessionHeartbeatTimeout(sessionId, timeoutMs + 120_000);

  try {
    // 1. init. The worker protocol's InitCommand.providerConfig expects
    // `baseURL` (uppercase), but the runner receives `baseUrl` (lowercase).
    // Normalize here and fall back to the provider default so the curator
    // subprocess never starts without an endpoint (which caused 401).
    const initMsg: InitCommand = {
      type: 'init',
      sessionId,
      providerConfig: {
        apiKey: providerConfig.apiKey,
        baseURL: providerConfig.baseUrl || resolveDefaultBaseURL(providerConfig.provider as Parameters<typeof resolveDefaultBaseURL>[0]),
        model: providerConfig.model,
        provider: providerConfig.provider,
        ...(providerConfig.authStyle ? { authStyle: providerConfig.authStyle } : {}),
        ...(providerConfig.visionConfig ? { visionConfig: providerConfig.visionConfig } : {}),
      },
      workingDirectory: memoryRoot,
      browserBackendMode,
      // No skillPaths, no AGENTS.md injection — curator runs headless.
    };
    pool.send(sessionId, initMsg as unknown as Record<string, unknown>);

    // 2. chat:start with curator options.
    const prompt = buildCuratorInitialMessage(memoryRoot, inputs, runId);
    const startMsg: ChatStartCommand = {
      type: 'chat:start',
      sessionId,
      id: runId,
      prompt,
      options: {
        systemPrompt: CURATOR_SYSTEM_PROMPT,
        allowedTools: ['read', 'grep', 'glob', 'memory_write', 'write_stage1_policy'],
        agentProfileId: 'memory-curator',
        mode: 'automation',
        excludeFromStage1: true,
        // Headless curator: bypass interactive permissions so tool calls
        // never block on an unanswered `ask`.
        permissionModeOverride: 'bypassPermissions',
        // Disable MiniMax adaptive thinking: with effort undefined MiniMax-M3
        // enters adaptive thinking and can emit an endless thinking stream
        // that never converges, hanging the whole run (see withIdleTimeout
        // note). effort:'off' forces a direct, fast answer.
        effort: 'off',
        // Cap a single LLM request at 240s so a hung final-answer call
        // (MiniMax-M3 thinking stream that never converges) fails the run
        // fast instead of burning the whole 20-minute run budget.
        llmRequestTimeoutMs: 240_000,
      },
    };
    pool.send(sessionId, startMsg as unknown as Record<string, unknown>);

    // 3. Wait for chat:done / chat:error / timeout.
    await waitForAgentCompletion(pool, sessionId, timeoutMs);
  } finally {
    // 4. releaseAndWait — hard boundary before the next run.
    await pool.releaseAndWait(sessionId, { gracefulMs });
  }

  return {
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

    function cleanup(): void {
      clearTimeout(timer);
      pool.removeMessageHandler(sessionId, handler);
    }

    pool.onMessage(sessionId, handler);
  });
}

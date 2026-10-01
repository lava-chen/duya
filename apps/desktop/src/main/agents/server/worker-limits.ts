/**
 * Adaptive worker limits shared by the Agent Server router, interagent
 * router, and worker manager (plan 426 Phase 1/2/3).
 *
 * Pure `os`-based calculations with env overrides. MUST stay free of
 * Electron imports — the agent server runs as a raw Node.js child process
 * where the `electron` module is unavailable.
 */
import * as os from 'os';
import type { PerformanceConfig } from '../../config/schema';

const GB = 1024 * 1024 * 1024;

/** Hard ceiling regardless of hardware (mirrors the old MAX_CONCURRENT_WORKERS = 16). */
export const WORKER_CAP_HARD_MAX = 16;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether the agent server was launched in low-power mode. The main
 * process resolves `performance.lowPower` ('auto' | 'on' | 'off') once at
 * startup and propagates the result via this env var.
 */
export function isLowPowerEnv(): boolean {
  const v = process.env.DUYA_LOW_POWER;
  return v === '1' || v === 'true';
}

/**
 * Adaptive worker concurrency cap (plan 426 Phase 1.1).
 *
 * - CPU budget: one worker per 2 cores (floor 1) — same base as the
 *   process pool's `calculateMaxConcurrent()`.
 * - Total-memory budget: <8GB → 2, <16GB → 4, otherwise up to the hard
 *   cap. Low-spec machines must not host many workers concurrently.
 * - lowPower mode caps the result at 2 (plan 426 Phase 3.5).
 * - `DUYA_MAX_CONCURRENT_WORKERS` env var overrides everything (ops/testing).
 */
export function calculateMaxConcurrentWorkers(lowPower = isLowPowerEnv()): number {
  const envMax = parsePositiveInt(process.env.DUYA_MAX_CONCURRENT_WORKERS);
  if (envMax !== null) return Math.min(envMax, WORKER_CAP_HARD_MAX);

  const cpuCores = os.cpus().length;
  const cpuLimit = Math.max(Math.floor(cpuCores / 2), 1);

  const totalMemGB = os.totalmem() / GB;
  const memCap = totalMemGB < 8 ? 2 : totalMemGB < 16 ? 4 : WORKER_CAP_HARD_MAX;

  let max = Math.min(cpuLimit, memCap);
  if (lowPower) max = Math.min(max, 2);
  return Math.max(Math.min(max, WORKER_CAP_HARD_MAX), 1);
}

/**
 * System memory usage ratio above which new chats are rejected
 * (plan 426 Phase 1.2). Default 0.90 — the old 0.98 let low-spec
 * machines page to death before the guard fired.
 * `DUYA_MEMORY_THRESHOLD` env var overrides.
 */
export function getWorkerMemoryThreshold(): number {
  const env = parseFloat(process.env.DUYA_MEMORY_THRESHOLD || '');
  return Number.isFinite(env) && env > 0 && env <= 1 ? env : 0.9;
}

/**
 * Per-worker `--max-old-space-size` in MB (plan 426 Phase 1.3).
 * Default 2048 on machines with ≥8GB total RAM, 1024 below that.
 * `DUYA_WORKER_MAX_MEMORY_MB` env var overrides.
 */
export function getWorkerMaxMemoryMB(): number {
  const env = parsePositiveInt(process.env.DUYA_WORKER_MAX_MEMORY_MB);
  if (env !== null) return env;
  return os.totalmem() / GB < 8 ? 1024 : 2048;
}

function positiveIntFromValue(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined;
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : undefined;
}

/**
 * Map `[performance]` worker-pool config into the same env vars the node-side
 * limits read at boot. Absent / 0 / negative → `{}` (adaptive auto defaults
 * apply). Electron-free pure function so callers can wire them wherever they
 * like (e.g. the main process populating the agent-server spawn env).
 */
export function workerLimitEnvFromConfig(perf?: Partial<PerformanceConfig>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const max = positiveIntFromValue(perf?.max_concurrent_workers);
  if (max !== undefined) env.DUYA_MAX_CONCURRENT_WORKERS = String(max);
  const ttl = positiveIntFromValue(perf?.worker_idle_ttl_ms);
  if (ttl !== undefined) env.DUYA_WORKER_IDLE_TTL_MS = String(ttl);
  const mem = positiveIntFromValue(perf?.worker_max_memory_mb);
  if (mem !== undefined) env.DUYA_WORKER_MAX_MEMORY_MB = String(mem);
  return env;
}

/** Default idle TTL before an idle worker is reaped: 10 minutes. */
export const WORKER_IDLE_TTL_MS = 10 * 60 * 1000;
/** lowPower idle TTL (plan 426 Phase 3.5): 4 minutes. */
export const WORKER_IDLE_TTL_LOW_POWER_MS = 4 * 60 * 1000;

/**
 * Idle TTL for worker recycling (plan 426 Phase 2.2). lowPower shortens
 * it to 4 minutes. `DUYA_WORKER_IDLE_TTL_MS` env var overrides.
 */
export function getWorkerIdleTtlMs(lowPower = isLowPowerEnv()): number {
  const env = parsePositiveInt(process.env.DUYA_WORKER_IDLE_TTL_MS);
  if (env !== null) return env;
  return lowPower ? WORKER_IDLE_TTL_LOW_POWER_MS : WORKER_IDLE_TTL_MS;
}

export interface IdleCandidate {
  sessionId: string;
  /** Last activity timestamp (ms epoch). Missing → treat as just spawned. */
  lastActivityAt: number | undefined;
  /** Per-session keepAlive exemption (cron/shared sessions, plan 426 Phase 2.3). */
  keepAlive: boolean;
  /**
   * Session state name. Workers in STREAMING/COMPLETING states are never
   * reaped — only settled (IDLE/COMPLETED/ERROR/CRASHED) ones are.
   */
  state: string | undefined;
}

/**
 * Pure decision helper for the idle reaper (plan 426 Phase 2): given the
 * current worker census, return the session ids that have been idle past
 * the TTL and are safe to kill.
 */
export function selectIdleSessionIds(candidates: IdleCandidate[], now: number, ttlMs: number): string[] {
  const victims: string[] = [];
  for (const c of candidates) {
    if (c.keepAlive) continue;
    if (c.state === 'STREAMING' || c.state === 'COMPLETING') continue;
    const last = c.lastActivityAt ?? now;
    if (now - last >= ttlMs) victims.push(c.sessionId);
  }
  return victims;
}

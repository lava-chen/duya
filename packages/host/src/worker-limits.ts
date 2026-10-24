/**
 * Host-owned worker resource policy and child-process environment.
 *
 * These calculations are Node-only and shared by the Host Worker Manager,
 * Agent Server compatibility runtime, and workflow workers. Keep Electron
 * configuration types and APIs outside this module.
 */

import nodeModule from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';

const GB = 1024 * 1024 * 1024;

/** Hard ceiling regardless of hardware (mirrors the former pool limit). */
export const WORKER_CAP_HARD_MAX = 16;

export interface WorkerPoolConfig {
  readonly max_concurrent_workers?: number;
  readonly worker_idle_ttl_ms?: number;
  readonly worker_max_memory_mb?: number;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The supervising Host resolves this once and forwards it to its workers. */
export function isLowPowerEnv(): boolean {
  const value = process.env.DUYA_LOW_POWER;
  return value === '1' || value === 'true';
}

/**
 * Adaptive worker concurrency cap.
 *
 * CPU budget is one worker per two cores. Memory limits are two workers below
 * 8GB, four below 16GB, and the hard cap above that. Low-power mode caps at two.
 */
export function calculateMaxConcurrentWorkers(lowPower = isLowPowerEnv()): number {
  const envMax = parsePositiveInt(process.env.DUYA_MAX_CONCURRENT_WORKERS);
  if (envMax !== null) return Math.min(envMax, WORKER_CAP_HARD_MAX);

  const cpuLimit = Math.max(Math.floor(os.cpus().length / 2), 1);
  const totalMemGB = os.totalmem() / GB;
  const memoryLimit = totalMemGB < 8 ? 2 : totalMemGB < 16 ? 4 : WORKER_CAP_HARD_MAX;

  let max = Math.min(cpuLimit, memoryLimit);
  if (lowPower) max = Math.min(max, 2);
  return Math.max(Math.min(max, WORKER_CAP_HARD_MAX), 1);
}

/** System memory usage ratio above which new chats are rejected. */
export function getWorkerMemoryThreshold(): number {
  const value = parseFloat(process.env.DUYA_MEMORY_THRESHOLD || '');
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.9;
}

/** Per-worker `--max-old-space-size` in MB. */
export function getWorkerMaxMemoryMB(): number {
  const envMax = parsePositiveInt(process.env.DUYA_WORKER_MAX_MEMORY_MB);
  if (envMax !== null) return envMax;
  return os.totalmem() / GB < 8 ? 1024 : 2048;
}

function positiveIntFromValue(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** Map persisted worker settings to the environment consumed at Host startup. */
export function workerLimitEnvFromConfig(config?: WorkerPoolConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const max = positiveIntFromValue(config?.max_concurrent_workers);
  if (max !== undefined) env.DUYA_MAX_CONCURRENT_WORKERS = String(max);
  const ttl = positiveIntFromValue(config?.worker_idle_ttl_ms);
  if (ttl !== undefined) env.DUYA_WORKER_IDLE_TTL_MS = String(ttl);
  const memory = positiveIntFromValue(config?.worker_max_memory_mb);
  if (memory !== undefined) env.DUYA_WORKER_MAX_MEMORY_MB = String(memory);
  return env;
}

export const WORKER_IDLE_TTL_MS = 10 * 60 * 1000;
export const WORKER_IDLE_TTL_LOW_POWER_MS = 4 * 60 * 1000;

/** Idle TTL before reaping; low-power mode shortens it to four minutes. */
export function getWorkerIdleTtlMs(lowPower = isLowPowerEnv()): number {
  const envTtl = parsePositiveInt(process.env.DUYA_WORKER_IDLE_TTL_MS);
  if (envTtl !== null) return envTtl;
  return lowPower ? WORKER_IDLE_TTL_LOW_POWER_MS : WORKER_IDLE_TTL_MS;
}

export interface IdleCandidate {
  readonly sessionId: string;
  /** Missing timestamps are treated as just spawned. */
  readonly lastActivityAt: number | undefined;
  readonly keepAlive: boolean;
  readonly state: string | undefined;
}

/** Select settled workers that have exceeded their configured idle TTL. */
export function selectIdleSessionIds(
  candidates: readonly IdleCandidate[],
  now: number,
  ttlMs: number,
): string[] {
  const victims: string[] = [];
  for (const candidate of candidates) {
    if (candidate.keepAlive) continue;
    if (candidate.state === 'STREAMING' || candidate.state === 'COMPLETING') continue;
    const lastActivityAt = candidate.lastActivityAt ?? now;
    if (now - lastActivityAt >= ttlMs) victims.push(candidate.sessionId);
  }
  return victims;
}

/**
 * Directory where Node keeps its on-disk compile cache for workers.
 *
 * ## Why the worker needs it
 *
 * The worker bundle is 4.6 MB of CommonJS, and Node compiles all of it on
 * every spawn. Measured on this machine, spawning the real bundle costs
 * ~172 ms without a cache and ~103 ms with a warm one -- about 68 ms of V8
 * compile time per worker.
 *
 * ## Why the ENVIRONMENT variable, not `enableCompileCache()`
 *
 * `module.enableCompileCache()` turns the cache on for the CURRENT process
 * and does not export `NODE_COMPILE_CACHE`, so a child started afterwards
 * inherits nothing. `NODE_COMPILE_CACHE` is the only channel that reaches
 * a fresh process, and it DOES cover the entry point -- verified against the
 * real bundle, whose entry file is cached like any other module.
 *
 * ## Why the worker must FLUSH the cache
 *
 * Node writes the compile cache to disk only when a process exits CLEANLY.
 * The Host kills its workers (SIGTERM, and SIGKILL on Windows), and a killed
 * process leaves NOTHING behind -- not the cache entry it just built. Without
 * an explicit flush the cache directory stays empty, so every spawn pays the
 * compile AND the cost of building a cache entry that is thrown away.
 * `flushWorkerCompileCache()` writes it while the worker is still alive.
 *
 * ## Why the cache lives under the data root
 *
 * Node's own guidance is to keep the cache under `os.tmpdir()` so a stale
 * cache cannot fill the disk. But a temp directory is also cleared by the
 * OS and by every "clean temp files" sweep, and this cache is worth
 * ~60 ms on EVERY worker spawn -- so a cache that vanishes overnight
 * costs the user that saving again on the next morning.
 *
 * The data root is the same place the worker already writes its logs, so
 * it inherits the user's existing expectations about where Duya keeps
 * state. Node's cache entry is keyed by the bundle's content hash, so a
 * rebuilt bundle simply misses the cache and writes a new entry; the old
 * entry is inert. Growth is bounded by how often the bundle changes, not
 * by how often a worker spawns.
 */
export function resolveWorkerCompileCacheDir(): string {
  return path.join(resolveDataRoot(), 'cache', 'node-compile');
}

/**
 * Write the accumulated compile cache to disk while the worker is alive.
 *
 * Node only persists the compile cache when a process exits cleanly, and the
 * Host kills its workers -- so without this call the cache directory stays
 * empty and every spawn recompiles the bundle from scratch.
 *
 * The flush is synchronous and costs ~2-4 ms for the 4.6 MB bundle. It is
 * best-effort: a runtime without the API, a disabled cache or a write error
 * must degrade to today's behaviour, never fail a worker.
 */
export function flushWorkerCompileCache(): void {
  if (process.env['NODE_DISABLE_COMPILE_CACHE']) return;
  const flush = (nodeModule as unknown as { flushCompileCache?: () => void }).flushCompileCache;
  if (typeof flush !== 'function') return;
  try {
    flush.call(nodeModule);
  } catch {
    // The compile cache is an optimisation; failing to write it is not a
    // reason to take the worker down.
  }
}

/**
 * Construct the environment shared by chat and workflow worker processes.
 *
 * `NODE_COMPILE_CACHE` is set here, and not at the spawn sites, because
 * this is the one function every worker path already goes through: the
 * Host Worker Manager, the Desktop's Worker Manager (which extends it),
 * and the workflow runtime manager. Setting it in one place is what keeps
 * the Desktop path -- which spawns the same bundle through a different
 * code path -- from silently missing the optimization.
 */
export function createWorkerEnvironment(
  sessionId: string,
  maxMemoryMB: number,
  betterSqlite3Path: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SESSION_ID: sessionId,
    DUYA_AGENT_MODE: 'true',
    DUYA_AGENT_SERVER: 'true',
    DUYA_BETTER_SQLITE3_PATH: process.env.DUYA_BETTER_SQLITE3_PATH || betterSqlite3Path,
    DUYA_WORKER_LOG_DIR: process.env.DUYA_WORKER_LOG_DIR ?? path.join(resolveDataRoot(), 'logs'),
    DUYA_CUSTOM_DB_PATH: process.env.DUYA_CUSTOM_DB_PATH,
    NODE_OPTIONS: `--max-old-space-size=${maxMemoryMB}`,
    // An explicit setting wins: an operator who pointed the cache
    // elsewhere (or turned it off with NODE_DISABLE_COMPILE_CACHE) keeps
    // their choice, and the worker inherits it rather than overriding.
    NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? resolveWorkerCompileCacheDir(),
  };
}

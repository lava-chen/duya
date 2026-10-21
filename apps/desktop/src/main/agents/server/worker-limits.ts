/** Compatibility export. Worker resource policy belongs to @duya/host. */
export {
  WORKER_CAP_HARD_MAX,
  WORKER_IDLE_TTL_LOW_POWER_MS,
  WORKER_IDLE_TTL_MS,
  calculateMaxConcurrentWorkers,
  getWorkerIdleTtlMs,
  getWorkerMaxMemoryMB,
  getWorkerMemoryThreshold,
  isLowPowerEnv,
  selectIdleSessionIds,
  workerLimitEnvFromConfig,
} from '@duya/host/worker-limits';
export type { IdleCandidate, WorkerPoolConfig } from '@duya/host/worker-limits';

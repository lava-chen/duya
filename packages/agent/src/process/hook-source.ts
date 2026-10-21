/** Compatibility re-export; the worker hook source is owned by Host. */

export {
  createWorkerHookSource as createLegacyHookSource,
  MAPPED_PHASES,
} from '@duya/host/worker-hooks/engine-source';
export type {
  WorkerHookSourceOptions as LegacyHookSourceOptions,
} from '@duya/host/worker-hooks/engine-source';

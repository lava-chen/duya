/**
 * @deprecated Use useDefaultProviderId. The single-active concept is gone;
 * the default is a soft preference, not a lock. This file is a thin
 * shim that re-exports the new hook. Will be removed once all callers
 * migrate.
 */
export { useDefaultProviderId as useActiveProviderId } from './useDefaultProviderId';

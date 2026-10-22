/**
 * scm/index.ts — public surface of the read-only SCM observer (plan 621 C).
 *
 * Slice E (Integration sync) consumes exactly this: observe PR + CI + review
 * facts, then write them into the `observed_*` projection. Nothing here writes,
 * so importing this module cannot change GitHub, the DB, or the filesystem.
 */

export {
  createGhRunner,
  GH_MAX_BUFFER_BYTES,
  GH_TIMEOUT_MS,
  GhError,
  parseGhJson,
  readJsonField,
  resolveGhPath,
} from './gh-cli.js';
export type {
  GhErrorCode,
  GhExecFile,
  GhExecOptions,
  GhExecResult,
  GhPathLookup,
  GhRunOptions,
  GhRunner,
  GhRunnerDeps,
} from './gh-cli.js';

export {
  deriveIntegrationState,
  observePr,
  observePrsForRefs,
  parsePrList,
  parsePrView,
} from './observe.js';
export type {
  GhPrRefMatch,
  GhPrView,
  ObservedPrFacts,
  ObservedRefFacts,
  PrCheckOutcome,
  PrIntegrationSignal,
  ScmObserverDeps,
} from './observe.js';

export type { HostIntegrationState } from './integration-state.js';

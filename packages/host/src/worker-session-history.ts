/**
 * The Host's compatibility surface for session history restore.
 *
 * ## Why this file still exists
 *
 * The implementation moved to `@duya/agent-runtime/session` (R1.1). The OLD
 * names are still exported here because this path is a PUBLISHED subpath
 * (`packages/host/package.json`, `"./worker-session-history"`) — breaking it
 * in the same diff that moved the code would make "the code moved" and "a
 * consumer broke" indistinguishable.
 *
 * A forwarding layer keeps them as two facts. The diff shows the
 * implementation leaving this package, and a consumer that breaks shows up
 * separately, with its own cause. A second copy of the function would have
 * hidden both.
 *
 * ## What is NOT here
 *
 * The old names are aliases, not wrappers. `hydrateWorkerSessionHistory` and
 * `hydrateSessionHistory` are the same function object, and the Host's test
 * asserts that identity — a forwarding layer that re-wrapped the call would
 * still type-check and would still pass a behavioural test, while quietly
 * becoming a second implementation.
 */

export type {
  SessionHistoryPorts as WorkerSessionHistoryPorts,
  SessionHistoryLoad as WorkerSessionHistoryLoad,
  SessionHistoryRepairResult as WorkerSessionHistoryRepairResult,
  SessionHistory as WorkerSessionHistory,
} from '@duya/agent-runtime/session';

export { hydrateSessionHistory as hydrateWorkerSessionHistory } from '@duya/agent-runtime/session';

// The current names, re-exported so a Host consumer that has been migrated
// does not have to reach past this file into the Runtime package to reach the
// same implementation.
export type {
  SessionHistoryPorts,
  SessionHistoryLoad,
  SessionHistoryRepairResult,
  SessionHistory,
} from '@duya/agent-runtime/session';

export { hydrateSessionHistory } from '@duya/agent-runtime/session';

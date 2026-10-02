/**
 * `@duya/agent-protocol/testing` — reference implementations for consumers.
 *
 * NOT re-exported from the package root. These are the pieces a host would
 * otherwise write once per codebase, and a second implementation is a second
 * set of bugs:
 *
 *  - `run-ledger.ts` — the run state machine and its invariants. Every rule in
 *    `test/lifecycle-invariants.test.ts` is enforced by this code, so a host
 *    that needs different rules can write its own but cannot claim the protocol
 *    permits something this one rejects.
 *  - `fixtures.ts` — one valid payload per event type.
 *
 * They live under `testing/` rather than the root so that depending on them is
 * a deliberate act, and so a future decision to drop them cannot break a
 * production import.
 */

export * from './fixtures.js';
export * from './run-ledger.js';
export * from './worker-adapter.js';

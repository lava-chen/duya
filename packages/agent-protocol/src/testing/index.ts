/**
 * `@duya/agent-protocol/testing` — fixtures and assertion helpers.
 *
 * NOT re-exported from the package root. These are the pieces a host would
 * otherwise write once per codebase, and a second implementation is a second
 * set of bugs:
 *
 *  - `fixtures.ts` — one valid payload per event type.
 *  - `run-ledger.js` — re-exported from the package ROOT, not defined here.
 *    The ledger is the protocol's own state machine and production runtimes
 *    depend on it, so it lives at `src/run-ledger.ts`; contract §H forbids
 *    importing a production ledger from `/testing`. It stays reachable from
 *    here so an existing `/testing` import keeps working — every rule in
 *    `test/lifecycle-invariants.test.ts` is still enforced by this code, so a
 *    host that needs different rules can write its own but cannot claim the
 *    protocol permits something this one rejects.
 *
 * The remainder of what lives under `testing/` is kept out of the root so that
 * depending on it stays a deliberate act, and so a future decision to drop the
 * fixtures cannot break a production import.
 */

export * from './fixtures.js';
export * from '../run-ledger.js';
export * from './worker-adapter.js';

/**
 * `@duya/memory/testing` -- the schema fixture the package's own tests build on.
 *
 * Plan 610 A5. The host (`apps/desktop/src/main/memory-state/migrations/`)
 * owns `memory-state.db`'s schema, so this package cannot own the migrations
 * without depending on the host. Instead it states the schema it REQUIRES as
 * `MEMORY_STATE_FIXTURE_DDL`, and the host's
 * `apps/desktop/src/main/memory-state/__tests__/agent-fixture-drift.test.ts`
 * checks the two agree by reading this directory's `schema-ddl.ts` as TEXT, by
 * path, at test time.
 *
 * That test reads the file rather than importing it on purpose: importing it
 * would trade one boundary violation for another, since a host file reaching
 * into `packages/` by relative path is the coupling plan 587 M5.1 was cutting.
 * So the file has to keep its own path on disk, and the drift test names it
 * directly.
 */

export { MEMORY_STATE_FIXTURE_DDL } from './schema-ddl.js';
export { createMemoryStateFixture } from './fixture.js';
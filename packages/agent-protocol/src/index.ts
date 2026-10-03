/**
 * `@duya/agent-protocol` — the single public entry.
 *
 * Transport-neutral wire contract for Duya agent runs. Types only: this package
 * has ZERO runtime dependencies, and drift test #1 fails the build if that
 * changes. That constraint is the whole reason it exists — an
 * `xai-grok-sampling-types`-style "pure data types" package that quietly pulls
 * in an HTTP client is the exact failure mode this constraint exists to stop.
 *
 * `legacy/` and `testing/` are reachable as subpath exports
 * (`@duya/agent-protocol/legacy`, `/testing`) and are deliberately NOT
 * re-exported here, so neither can become a permanent part of the surface.
 *
 * `run-ledger.ts` is the exception to the subpath rule, and it is here because
 * a production runtime depends on it: the ledger is the protocol's own state
 * machine, not a reference implementation for a host to copy. Contract §H
 * forbids a production ledger being imported from `/testing`, and a
 * "deliberate act" comment on the import cannot change where the file lives.
 * Only the two names production needs are re-exported — `run-ledger.ts` also
 * re-exports `eventKey` and `TOOL_LIFECYCLE_EVENTS`, which `envelope.js` and
 * `resume.js` already own, and a blanket `export *` would make those ambiguous.
 */

export * from './version.js';
export * from './compatibility.js';
export * from './hash.js';
export * from './primitives.js';
export * from './errors.js';
export * from './permission.js';
export * from './capabilities.js';
export * from './resume.js';
export * from './manifest.js';
export * from './envelope.js';
export * from './run.js';
export * from './transport.js';
export * from './framing.js';
export * from './codecs.js';

export * from './events/payloads.js';
export * from './events/registry.js';
export * from './events/required.js';

export { RunLedger, LifecycleViolation } from './run-ledger.js';
export type { LifecycleViolationCode } from './run-ledger.js';

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

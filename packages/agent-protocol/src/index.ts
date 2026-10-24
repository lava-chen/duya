/**
 * `@duya/agent-protocol` — the single public entry.
 *
 * Transport-neutral wire contract for Duya agent runs. This package has ZERO
 * runtime dependencies, and drift test #1 fails the build if that changes.
 * Runtime exports are pure codecs over these transport-neutral contracts. That
 * constraint is the whole reason it exists — an
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
export * from './tasks.js';
export * from './projects.js';
export * from './session-api.js';
export * from './session-fork.js';
// Session-level exits that create no run: manual compaction and side questions.
export * from './session-compaction.js';
export * from './rollout-events.js';
export type { JournalRecord } from './workflow-journal.js';
export * from './workflow-runs.js';
export * from './goals.js';
export * from './mode-state.js';
export * from './errors.js';
export * from './permission.js';
export * from './permission-requests.js';
export * from './tool-approvals.js';
export * from './locks.js';
export * from './background-tasks.js';
export * from './capabilities.js';
export * from './host-capabilities.js';
export { ingestMessage, ingestMessages } from './message-ingest.js';
export type { IngestMessageOptions, LegacyPersistedMessage } from './message-ingest.js';
export type { AgentMessage, MessageEntry } from './message-timeline.js';
export type { MessageContent } from './transcript/content.js';
export type { MessageContent as EventMessageContent } from './events/payloads.js';
export * from './resume.js';
export * from './checkpoint.js';
// Plan 587 T3.3 — the scoped resume cursor and the durable window it is
// checked against. Pure scope arithmetic, no storage, no transport.
export * from './replay.js';
export * from './manifest.js';
export * from './input-revision.js';
export * from './run-api.js';
export * from './envelope.js';
export * from './run.js';
export * from './transport.js';
export * from './framing.js';
export * from './codecs.js';
export * from './mailbox.js';
export * from './research-api.js';
export * from './agent-dm.js';
export * from './session-ids.js';
export * from './agent-dm.js';
export * from './wake.js';
export * from './pending-wakes.js';
export * from './terminal-history.js';
export * from './gateway-user-map.js';
export * from './channel-persistence.js';
export * from './channels.js';
export * from './agent-profiles.js';
export * from './gateway-directory.js';
export * from './gateway-allowlist.js';
export * from './gateway-message-mirror.js';
export * from './gateway-threads.js';
export * from './send-message-state.js';
export * from './model-capabilities.js';
export * from './provider-catalog.js';
export * from './app-connections.js';
export * from './plugin-setup.js';
export * from './plugin-app-instances.js';
export * from './plugin-app-invocations.js';
export * from './import-batches.js';
export * from './turn-review.js';
export * from './sidebar-sections.js';
export * from './usage-api.js';
export * from './host-health.js';

// Plan 621 slice B — observation contracts. Both describe facts the Host
// recomputes from git or GitHub; none of them is an identity (§4.3).
export * from './checkout-api.js';
export * from './integration-api.js';

export * from './events/payloads.js';
export * from './events/registry.js';
export * from './events/required.js';
export * from './events/criticality.js';

export { RunLedger, LifecycleViolation } from './run-ledger.js';
export type { LifecycleViolationCode } from './run-ledger.js';

export type { FileAttachment } from './file-attachment.js';
export type { CommunicationPlatform } from './communication-platform.js';

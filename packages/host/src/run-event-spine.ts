/**
 * Compat forwarding layer -- the implementation moved to `@duya/agent-runtime`.
 *
 * ## Why this file still exists
 *
 * The run event spine speaks only the protocol and the runtime's own ports,
 * so it is a RUNTIME concern and now lives at
 * `packages/agent-runtime/src/engine/run-event-spine.ts`. This module keeps
 * the `@duya/host/run-event-spine` subpath working for the consumers that
 * still import it from here.
 *
 * Delete it once the consumers are zero -- not before, because the public
 * subpath is part of the Host's published surface.
 */

export { createRunEventSpine } from '@duya/agent-runtime';
export type {
  RunEventSpine,
  RunEventSpineOptions,
  SpinePersistence,
} from '@duya/agent-runtime';

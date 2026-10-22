/**
 * One live subscription to one Host run, projected through the shared surface.
 *
 * ## This file is a RE-EXPORT
 *
 * The implementation lives in `@duya/client-core` (`run-event-stream.ts`),
 * because the Desktop surface needs the SAME admission rules and a second copy
 * would be a second thing to get wrong: the resume cursor, the UTF-8 split
 * character bug, the window batching — those only show up on the surface that
 * changed last.
 *
 * The shared implementation takes the transport as a PORT — "give me a byte
 * stream for this cursor" — because the Desktop renderer cannot reach the
 * Host's HTTP server at all (the Host refuses every request carrying an
 * `Origin` header). A surface that CAN reach it, like the Web over its
 * same-origin BFF, may use the `streamUrl` + `fetchImpl` pair instead, which
 * is the same transport expressed the way a browser spells it.
 *
 * The exported names are unchanged, so every consumer — and the tests in
 * `apps/web/tests/client/` — keep working without edits.
 */

export {
  RunEventStream,
  type RejectedFrameDetail,
  type RunStreamPhase,
  type RunStreamState,
  type RunEventStreamOptions,
  type RunStreamOpener,
  type StreamFetchLike,
} from '@duya/client-core';

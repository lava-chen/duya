/**
 * Server-sent-event framing for the browser run stream.
 *
 * This file is a RE-EXPORT. The implementation moved to
 * `packages/ui/src/services/sse.ts`, because the Desktop surface needs the
 * same decoder and a second copy would be a second thing to get wrong: the
 * UTF-8 split-character bug this decoder exists to prevent is exactly the
 * kind of defect that only shows up on the surface that changed last.
 *
 * The exported names are unchanged, so every consumer — and the tests in
 * `apps/web/tests/client/` — keep working without edits.
 *
 * ## Why this is hand written instead of `EventSource`
 *
 * Three reasons, each of which shows up in this product rather than in theory:
 *
 *  1. The resume cursor is a decision, not a browser default. `EventSource`
 *     reconnects on its own and replays `Last-Event-ID` on its own schedule.
 *     This client's cursor is `RunSession.lastAcceptedSeq` — the highest seq the
 *     shared surface model actually admitted — and it must resubscribe with
 *     exactly that number. A library-owned reconnect cannot express "resume
 *     from where the projection is", only "resume from where the socket was".
 *  2. The stream must be abortable as part of SELECTION, not just on unmount.
 *     Switching sessions has to release the previous subscription immediately;
 *     `EventSource.close()` cannot be raced against an in-flight reconnect.
 *  3. The stream carries application frames, not just events: `event: error`
 *     carries a structured `{ status, code }` payload the UI has to render, and
 *     the Host's own keep-alive comments must not be mistaken for either.
 *
 * The decoder is also the only place that can be wrong about UTF-8. A single
 * Chinese character is three bytes, and a network chunk can end between any two
 * of them. Decoding each chunk independently replaces the tail of a split
 * character with U+FFFD, which would corrupt a message the user is reading —
 * silently, and only sometimes. `TextDecoder` in streaming mode is the fix, and
 * a test that splits a payload mid character is what keeps it honest.
 */

export type { SseFrame } from '@duya/ui/services';
export { SseFrameDecoder } from '@duya/ui/services';

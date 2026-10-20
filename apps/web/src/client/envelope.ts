/**
 * Wire decoding for the browser transport.
 *
 * This file is a RE-EXPORT. The implementation moved to
 * `packages/ui/src/services/envelope.ts`, because the Desktop surface needs the
 * same validation and a second copy would be a second thing to get wrong.
 *
 * Every value that arrives from `fetch` is `unknown` until something says
 * otherwise, and the client is the last place that can say it. The BFF is a
 * same-origin facade over a typed Host API, but it speaks JSON over HTTP: the
 * types in `@duya/agent-protocol` describe the SHAPE, not the bytes on this
 * socket. A browser client that casts without looking produces two failures
 * that both look like "the server is broken": a render crash on a malformed
 * frame, and — worse — a frame that parses into an envelope with a plausible
 * `seq` but no payload, which the surface model would then admit as progress.
 *
 * So decoding here rejects rather than repairs. A rejected frame is dropped and
 * counted; it never becomes a half-truth.
 *
 * The exported names are unchanged, so every consumer — and the tests in
 * `apps/web/tests/client/` — keep working without edits.
 */

export type { DecodedRunFrame, IgnoredFrameReason } from '@duya/ui/services';
export {
  decodeRunFrame,
  isRecord,
  readRunEventEnvelope,
  RUN_EVENT_NAME,
  STREAM_ERROR_EVENT_NAME,
} from '@duya/ui/services';

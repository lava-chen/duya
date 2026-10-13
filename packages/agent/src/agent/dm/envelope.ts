/**
 * Legacy Agent DM codec exports. The transport-neutral implementation lives
 * in @duya/agent-protocol/agent-dm.
 */

export {
  encodeEnvelope,
  decodeEnvelope,
  clampAgentMessage,
  buildDedupeKey,
  buildNonceKey,
  canonicalEnvelopeInput,
  prepareEnvelopeForSend,
} from "@duya/agent-protocol";

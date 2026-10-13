/**
 * Legacy Agent DM exports. The wire contract now lives in agent-protocol so
 * clients and workers can share it without depending on the Agent package.
 */

export {
  AGENT_INBOUND_WAKE_CUE,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  AGENT_DM_INTENTS,
  computeEnvelopeDigest,
  isAgentDmEnvelope,
  isAgentDmIntent,
} from "@duya/agent-protocol";
export type {
  AgentDmEnvelope,
  AgentAddress,
  AgentDmIntent,
  ImageRef,
  DmMessageKind,
} from "@duya/agent-protocol";

/** Send-acceptance record persisted in SQLite for nonce-based deduplication. */
export interface SendAcceptanceRecord {
  clientNonce: string;
  inputDigest: string;
  status: "pending" | "accepted" | "rejected";
  acceptedAtMs: number;
  agentId: string;
  echoEntryId: string | null;
  rejectionCode: string | null;
}

/** Result of a send-acceptance check. */
export type SendAcceptanceOutcome =
  | { outcome: "dispatch" }
  | { outcome: "duplicate"; record: SendAcceptanceRecord }
  | { outcome: "rejected"; code: string };

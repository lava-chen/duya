/**
 * Agent-to-Agent DM Envelope Types (Plan 477 P1.1)
 *
 * Defines the envelope structure for asynchronous agent-to-agent messaging,
 * including nonce/digest for idempotency and priority support.
 */

import { createHash } from "node:crypto";

export const AGENT_INBOUND_WAKE_CUE = "[agent]";
export const AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;

export interface ImageRef {
  url: string;
  alt?: string;
}

/**
 * Agent-to-agent direct message envelope.
 * Produced by SendToAgent tool and consumed by the receiver's wake handler.
 */
export interface AgentDmEnvelope {
  from: AgentAddress;
  to: AgentAddress;
  text: string;
  images?: ImageRef[];
  priority?: boolean; // if true, interrupts recipient's non-user work
  timestampMs: number;
  /** Client-generated idempotency key. */
  clientMsgId: string;
  /**
   * Optional end-to-end delivery nonce.
   * Used in send-acceptance ledger for fine-grained deduplication beyond clientMsgId.
   */
  clientNonce?: string;
  /**
   * SHA-256 digest of the envelope content (excluding digest itself).
   * Allows recipient to verify content integrity.
   */
  digest?: string;
  /**
   * Set when a priority message is re-delivered after recipient was preempted.
   */
  isRedriven?: boolean;
  /**
   * Optional thread association: the message this one is replying to.
   */
  replyTo?: { messageId: string };
}

export interface AgentAddress {
  id: string;
  name: string;
}

export type DmMessageKind = "text" | "attachment" | "widget" | "connector";

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

/** Compute a SHA-256 digest of the envelope for integrity verification. */
export function computeEnvelopeDigest(envelope: AgentDmEnvelope): string {
  const canonical = JSON.stringify({
    f: envelope.from,
    t: envelope.to,
    txt: envelope.text,
    img: envelope.images ?? [],
    pri: envelope.priority ?? false,
    ts: envelope.timestampMs,
    mid: envelope.clientMsgId,
    nonce: envelope.clientNonce ?? null,
    replyTo: envelope.replyTo ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Validate that a raw object conforms to AgentDmEnvelope shape. */
export function isAgentDmEnvelope(value: unknown): value is AgentDmEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.from === "object" &&
    e.from !== null &&
    typeof (e.from as Record<string, unknown>).id === "string" &&
    typeof (e.from as Record<string, unknown>).name === "string" &&
    typeof e.to === "object" &&
    e.to !== null &&
    typeof (e.to as Record<string, unknown>).id === "string" &&
    typeof (e.to as Record<string, unknown>).name === "string" &&
    typeof e.text === "string" &&
    typeof e.timestampMs === "number" &&
    typeof e.clientMsgId === "string"
  );
}

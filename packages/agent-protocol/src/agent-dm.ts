/**
 * Transport-neutral agent-to-agent direct-message wire contract.
 *
 * This module deliberately stays free of platform APIs so workers, Desktop,
 * CLI, and remote Hosts can share the same envelope and codecs.
 */

import { sha256Hex } from './hash.js';

export const AGENT_INBOUND_WAKE_CUE = '[agent]';
export const AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;

/** Intent drives receiver wake prompts and automatic result return. */
export type AgentDmIntent = 'request' | 'result' | 'question' | 'status' | 'fyi';
export const AGENT_DM_INTENTS: readonly AgentDmIntent[] = [
  'request',
  'result',
  'question',
  'status',
  'fyi',
] as const;

export function isAgentDmIntent(value: unknown): value is AgentDmIntent {
  return typeof value === 'string' && (AGENT_DM_INTENTS as readonly string[]).includes(value);
}

export interface AgentAddress {
  id: string;
  name: string;
}

export interface ImageRef {
  url: string;
  alt?: string;
}

/** Agent-to-agent direct message envelope persisted in the mailbox. */
export interface AgentDmEnvelope {
  from: AgentAddress;
  to: AgentAddress;
  text: string;
  images?: ImageRef[];
  /** Interrupts recipient's non-user work when true. */
  priority?: boolean;
  intent?: AgentDmIntent;
  /** Bot-to-bot hop depth, assigned by the dispatcher. */
  hops?: number;
  timestampMs: number;
  /** Client-generated idempotency key. */
  clientMsgId: string;
  /** Optional end-to-end delivery nonce. */
  clientNonce?: string;
  /** SHA-256 digest of the envelope content, excluding digest itself. */
  digest?: string;
  /** Marks priority messages re-delivered after recipient preemption. */
  isRedriven?: boolean;
  /** The message this envelope replies to. */
  replyTo?: { messageId: string };
}

export type DmMessageKind = 'text' | 'attachment' | 'widget' | 'connector';

/** Compute the legacy-compatible SHA-256 digest of an envelope. */
export function computeEnvelopeDigest(envelope: AgentDmEnvelope): string {
  // Keep the key order and JSON.stringify semantics stable: persisted mailbox
  // envelopes may be verified by older workers after an application upgrade.
  const canonical = JSON.stringify({
    f: envelope.from,
    t: envelope.to,
    txt: envelope.text,
    img: envelope.images ?? [],
    pri: envelope.priority ?? false,
    intent: envelope.intent ?? null,
    hops: envelope.hops ?? null,
    ts: envelope.timestampMs,
    mid: envelope.clientMsgId,
    nonce: envelope.clientNonce ?? null,
    replyTo: envelope.replyTo ?? null,
  });
  return sha256Hex(canonical);
}

/** Validate the required shape of an agent DM envelope. */
export function isAgentDmEnvelope(value: unknown): value is AgentDmEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope.from === 'object' &&
    envelope.from !== null &&
    typeof (envelope.from as Record<string, unknown>).id === 'string' &&
    typeof (envelope.from as Record<string, unknown>).name === 'string' &&
    typeof envelope.to === 'object' &&
    envelope.to !== null &&
    typeof (envelope.to as Record<string, unknown>).id === 'string' &&
    typeof (envelope.to as Record<string, unknown>).name === 'string' &&
    typeof envelope.text === 'string' &&
    typeof envelope.timestampMs === 'number' &&
    typeof envelope.clientMsgId === 'string'
  );
}

/** Encode an envelope as JSON, adding its digest when one was not supplied. */
export function encodeEnvelope(envelope: AgentDmEnvelope): string {
  const withDigest =
    envelope.digest !== undefined
      ? envelope
      : { ...envelope, digest: computeEnvelopeDigest(envelope) };
  return JSON.stringify(withDigest);
}

/** Decode a JSON envelope, returning null for malformed or incomplete input. */
export function decodeEnvelope(raw: string): AgentDmEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isAgentDmEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Clamp message text to the persisted mailbox limit. */
export function clampAgentMessage(text: string): string {
  if (text.length <= AGENT_MESSAGE_MAX_TEXT_LENGTH) return text;
  const truncated = text.slice(0, AGENT_MESSAGE_MAX_TEXT_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > AGENT_MESSAGE_MAX_TEXT_LENGTH * 0.8) {
    return truncated.slice(0, lastSpace) + '…';
  }
  return truncated + '…';
}

/** Build the mailbox deduplication key from a message envelope. */
export function buildDedupeKey(
  envelope: Pick<AgentDmEnvelope, 'from' | 'to' | 'clientMsgId'>,
): string {
  return `dm:${envelope.from.id}:${envelope.to.id}:${envelope.clientMsgId}`;
}

/** Build a nonce key for the send-acceptance ledger. */
export function buildNonceKey(accountSlot: string, clientNonce: string): string {
  return `${accountSlot}\0${clientNonce}`;
}

/** Canonical payload used when computing send-acceptance input digests. */
export function canonicalEnvelopeInput(
  agentId: string | undefined,
  text: string,
  images: ImageRef[] | undefined,
): string {
  return JSON.stringify([agentId ?? null, text, images ?? null]);
}

/** Clamp and digest an envelope immediately before sending. */
export function prepareEnvelopeForSend(
  envelope: Omit<AgentDmEnvelope, 'digest'>,
): AgentDmEnvelope {
  return {
    ...envelope,
    text: clampAgentMessage(envelope.text),
    digest: computeEnvelopeDigest(envelope),
  };
}

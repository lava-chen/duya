/**
 * Agent-to-Agent DM Envelope Codec (Plan 477 P1.1)
 *
 * Pure functions for encoding/decoding/validating agent DM envelopes.
 */

import {
  AgentDmEnvelope,
  ImageRef,
  isAgentDmEnvelope,
  computeEnvelopeDigest,
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
} from "./types.js";

/**
 * Encode an envelope to a JSON string.
 * Adds digest automatically if not already present.
 */
export function encodeEnvelope(env: AgentDmEnvelope): string {
  const withDigest =
    env.digest !== undefined
      ? env
      : { ...env, digest: computeEnvelopeDigest(env) };
  return JSON.stringify(withDigest);
}

/**
 * Decode a JSON string into an envelope.
 * Returns null if the string is invalid or missing required fields.
 */
export function decodeEnvelope(raw: string): AgentDmEnvelope | null {
  try {
    const parsed = JSON.parse(raw);
    return isAgentDmEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Clamp agent message text to the maximum allowed length.
 * Truncates at word boundary when possible.
 */
export function clampAgentMessage(text: string): string {
  if (text.length <= AGENT_MESSAGE_MAX_TEXT_LENGTH) return text;
  const truncated = text.slice(0, AGENT_MESSAGE_MAX_TEXT_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > AGENT_MESSAGE_MAX_TEXT_LENGTH * 0.8) {
    return truncated.slice(0, lastSpace) + "…";
  }
  return truncated + "…";
}

/**
 * Build a deduplication key from an envelope.
 * Uses clientMsgId as the primary key for basic deduplication.
 */
export function buildDedupeKey(env: Pick<AgentDmEnvelope, "from" | "to" | "clientMsgId">): string {
  return `dm:${env.from.id}:${env.to.id}:${env.clientMsgId}`;
}

/**
 * Build a nonce-based dedupe key for send-acceptance ledger.
 */
export function buildNonceKey(accountSlot: string, clientNonce: string): string {
  return `${accountSlot}\0${clientNonce}`;
}

/**
 * Build the canonical input for digest computation.
 * Matches grok-bot's canonicalSendInput pattern.
 */
export function canonicalEnvelopeInput(
  agentId: string | undefined,
  text: string,
  images: ImageRef[] | undefined,
): string {
  return JSON.stringify([
    agentId ?? null,
    text,
    images ?? null,
  ]);
}

/**
 * Validate and clamp an envelope before sending.
 * Returns a sanitized envelope with clamped text and computed digest.
 */
export function prepareEnvelopeForSend(
  env: Omit<AgentDmEnvelope, "digest">,
): AgentDmEnvelope {
  return {
    ...env,
    text: clampAgentMessage(env.text),
    digest: computeEnvelopeDigest(env),
  };
}

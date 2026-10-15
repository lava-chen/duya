import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_MESSAGE_MAX_TEXT_LENGTH,
  buildDedupeKey,
  buildNonceKey,
  canonicalEnvelopeInput,
  clampAgentMessage,
  computeEnvelopeDigest,
  decodeEnvelope,
  encodeEnvelope,
  isAgentDmEnvelope,
  prepareEnvelopeForSend,
  type AgentDmEnvelope,
} from '../src/agent-dm.js';

const envelope: AgentDmEnvelope = {
  from: { id: 'agent-a', name: 'A' },
  to: { id: 'agent-b', name: 'B' },
  text: '你好',
  timestampMs: 42,
  clientMsgId: 'msg-1',
};

describe('agent DM protocol', () => {
  it('preserves the legacy digest bytes for persisted envelopes', () => {
    const digest = computeEnvelopeDigest(envelope);
    expect(digest).toBe('7f30d7a854b5c0bfb88bfc648f2d1327188044de1a3b95e1d01e7f45c57a608c');

    const legacyCanonical = JSON.stringify({
      f: envelope.from,
      t: envelope.to,
      txt: envelope.text,
      img: [],
      pri: false,
      intent: null,
      hops: null,
      ts: envelope.timestampMs,
      mid: envelope.clientMsgId,
      nonce: null,
      replyTo: null,
    });
    expect(digest).toBe(createHash('sha256').update(legacyCanonical, 'utf8').digest('hex'));
  });

  it('encodes with a digest and decodes valid envelopes only', () => {
    const encoded = encodeEnvelope(envelope);
    expect(JSON.parse(encoded).digest).toBe(computeEnvelopeDigest(envelope));
    expect(decodeEnvelope(encoded)).toEqual({ ...envelope, digest: computeEnvelopeDigest(envelope) });
    expect(decodeEnvelope('{')).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ text: 'missing fields' }))).toBeNull();
    expect(isAgentDmEnvelope(envelope)).toBe(true);
  });

  it('keeps the text limit and send-preparation behavior', () => {
    expect(clampAgentMessage('short')).toBe('short');
    expect(clampAgentMessage('x'.repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH + 1))).toBe(
      `${'x'.repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH)}…`,
    );
    const prepared = prepareEnvelopeForSend({ ...envelope, text: 'x'.repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH + 1) });
    expect(prepared.text).toHaveLength(AGENT_MESSAGE_MAX_TEXT_LENGTH + 1);
    expect(prepared.digest).toBe(computeEnvelopeDigest({ ...envelope, text: 'x'.repeat(AGENT_MESSAGE_MAX_TEXT_LENGTH + 1) }));
  });

  it('retains mailbox keys and canonical send-input shape', () => {
    expect(buildDedupeKey(envelope)).toBe('dm:agent-a:agent-b:msg-1');
    expect(buildNonceKey('account', 'nonce')).toBe('account\0nonce');
    expect(canonicalEnvelopeInput(undefined, 'text', undefined)).toBe('[null,"text",null]');
  });
});

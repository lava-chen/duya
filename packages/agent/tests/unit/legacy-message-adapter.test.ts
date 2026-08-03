import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import {
  agentMessageToLegacyMessage,
  agentMessagesToLegacyMessages,
  legacyMessageToAgentMessage,
  legacyMessagesToAgentMessages,
} from '../../src/message/legacy-message-adapter.js';

describe('legacy message adapter', () => {
  it('round-trips every legacy field, provider state, signatures, attachments, and unknown metadata', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Result', textSignature: 'text-signature' },
        { type: 'thinking', thinking: 'Reasoning', thinkingSignature: 'thinking-signature' },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'read',
          input: { path: 'README.md' },
          thoughtSignature: 'tool-signature',
        },
      ],
      name: 'assistant-name',
      tool_call_id: 'call-1',
      timestamp: 1_700_000_000_000,
      metadata: { unknown: { nested: ['value'] } },
      msg_type: 'tool_use',
      thinking: 'persisted reasoning',
      tool_name: 'read',
      tool_input: '{"path":"README.md"}',
      parent_tool_call_id: 'parent-call',
      viz_spec: '{"kind":"chart"}',
      status: 'completed',
      seq_index: 7,
      duration_ms: 42,
      sub_agent_id: 'child-1',
      attachments: [{ name: 'image.png', type: 'image/png', imageChunks: ['abc'] }],
      displayContent: 'Visible result',
      isCompactBoundary: false,
      isCompactSummary: false,
      compactedMessageCount: 0,
      compactedMessageIds: [],
      compactBoundaryId: 'boundary-1',
      tokenUsage: { input_tokens: 12, output_tokens: 34, upstreamProvider: 'Anthropic' },
      providerId: 'provider-1',
      model: 'model-1',
      api: 'anthropic',
      responseId: 'response-1',
      providerState: { signature: 'provider-state-signature' },
    } satisfies Message & Record<string, unknown>;
    const original = structuredClone(message);

    const adapted = legacyMessageToAgentMessage(message);

    expect(adapted.kind).toBe('assistant');
    expect(adapted.metadata).toEqual({ unknown: { nested: ['value'] } });
    const serialized = JSON.stringify(adapted);
    // The adapter stores the lossless legacy envelope under a non-enumerable
    // Symbol sidecar (`Symbol('duya.legacy-message-adapter')`). Symbol-keyed
    // properties never appear in JSON.stringify, so the envelope description
    // must not leak; this also guards against a regression that swaps the
    // Symbol for an enumerable string key.
    expect(serialized).not.toContain('duya.legacy-message-adapter');
    expect(serialized).not.toContain('response-1');
    expect(serialized).not.toContain('provider-state-signature');
    expect(agentMessageToLegacyMessage(adapted)).toEqual(original);
    expect(message).toEqual(original);
  });

  it('maps roles without pretending system instructions are user intent', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'User request', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Assistant answer', timestamp: 2 },
      {
        id: 'tool-1',
        role: 'tool',
        name: 'read',
        tool_call_id: 'call-1',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false }],
        timestamp: 3,
      },
      {
        id: 'system-1',
        role: 'system',
        content: 'System rule',
        timestamp: 4,
        thinking: 'private legacy system state',
      },
    ];

    const adapted = legacyMessagesToAgentMessages(messages);

    expect(adapted.map((message) => message.kind)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'custom:legacy-system',
    ]);
    expect(adapted[3]).toMatchObject({
      payload: { content: 'System rule', name: undefined },
    });
    expect(JSON.stringify(adapted[3])).not.toContain('private legacy system state');
    expect(agentMessagesToLegacyMessages(adapted)).toEqual(messages);
  });

  it('preserves mailbox and task notifications as explicit runtime context', () => {
    const messages: Message[] = [
      { id: 'mailbox-1', role: 'user', content: 'Continue with this instruction', msg_type: 'mailbox' },
      { id: 'task-1', role: 'user', content: '<task-notification>done</task-notification>', msg_type: 'task_notification' },
    ];

    const adapted = legacyMessagesToAgentMessages(messages);

    expect(adapted[0]).toMatchObject({
      kind: 'runtime_context',
      source: 'mailbox',
      persistence: 'transient',
      visibility: 'hidden',
    });
    expect(adapted[1]).toMatchObject({
      kind: 'runtime_context',
      source: 'background_notification',
      persistence: 'transient',
      visibility: 'hidden',
    });
    expect(agentMessagesToLegacyMessages(adapted)).toEqual(messages);
  });

  it('keeps compaction summaries and boundaries distinct', () => {
    const messages: Message[] = [
      {
        id: 'summary-1',
        role: 'user',
        content: 'Earlier work summary',
        isCompactSummary: true,
        compactBoundaryId: 'boundary-1',
        compactedMessageCount: 12,
        compactedMessageIds: ['u1', 'a1'],
      },
      {
        id: 'boundary-1',
        role: 'user',
        content: '',
        isCompactBoundary: true,
      },
    ];

    const adapted = legacyMessagesToAgentMessages(messages);

    expect(adapted[0]).toMatchObject({
      kind: 'compaction_summary',
      compactionEntryId: 'boundary-1',
      tokensBefore: 12,
    });
    expect(adapted[1]?.kind).toBe('custom:legacy-compaction-boundary');
    expect(adapted[1]).toMatchObject({
      payload: { compactBoundaryId: undefined },
    });
    expect(agentMessagesToLegacyMessages(adapted)).toEqual(messages);
  });

  it('uses deterministic synthetic Agent ids without adding ids or timestamps on reverse conversion', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', media_type: 'image/png', data: 'https://example.test/a.png' } }],
        attachments: [{ name: 'a.png', type: 'image/png', url: 'https://example.test/a.png' }],
        metadata: { arbitrary: { value: true } },
      },
    ];
    const original = structuredClone(messages);

    const first = legacyMessagesToAgentMessages(messages);
    const second = legacyMessagesToAgentMessages(messages);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ id: 'legacy-message-0', createdAt: 0, kind: 'user' });
    expect(agentMessagesToLegacyMessages(first)).toEqual(original);
    expect(messages).toEqual(original);
  });

  it('rejects reverse conversion for native messages without an envelope', () => {
    expect(() => agentMessageToLegacyMessage({
      id: 'native-1',
      createdAt: 1,
      persistence: 'durable',
      visibility: 'visible',
      kind: 'user',
      content: 'native',
    })).toThrow('adapter envelope');
  });
});

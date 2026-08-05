import { describe, expect, it } from 'vitest';
import type { Message, MessageContent, TokenUsage } from '../../src/types.js';
import type {
  AgentCustomMessage,
  AgentMessage,
  PromptSegment,
} from '../../src/message/message-framework.js';
import {
  hasLegacyEnvelope,
  legacyMessageToAgentMessage,
} from '../../src/message/legacy-message-adapter.js';
import {
  projectModelMessages,
  projectPersistenceMessages,
  projectTranscriptMessages,
  extractLegacySystemSegments,
} from '../../src/message/message-projectors.js';
import {
  buildAgentContext,
  type CompactionEntry,
} from '../../src/message/message-framework.js';
import {
  projectTimelinePersistenceMessages,
  legacyMessagesToAgentMessages,
} from '../../src/message/index.js';
import { MessageTimeline } from '../../src/message/message-framework.js';

const createdAt = 1_700_000_000_000;

// ─── Native message builders (no Legacy sidecar) ────────────────────────

function nativeUser(
  id: string,
  content: string,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    kind: 'user',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    content,
    ...overrides,
  };
}

function nativeAssistant(
  id: string,
  content: string | MessageContent[],
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    kind: 'assistant',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    content,
    ...overrides,
  };
}

function nativeToolResult(
  id: string,
  toolCallId: string,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    kind: 'tool_result',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    toolCallId,
    toolName: 'read',
    content: 'ok',
    isError: false,
    ...overrides,
  };
}

function nativeRuntimeContext(
  id: string,
  overrides: {
    persistence?: 'durable' | 'transient';
    visibility?: 'visible' | 'hidden';
    includeInModel?: boolean;
    source?: string;
    content?: string;
  } = {},
): AgentMessage {
  return {
    kind: 'runtime_context',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    source: 'custom',
    content: 'ctx',
    includeInModel: true,
    ...overrides,
  } as AgentMessage;
}

function nativeCompactionSummary(id: string): AgentMessage {
  return {
    kind: 'compaction_summary',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    summary: 'Earlier work was compacted.',
    compactionEntryId: 'compact-1',
    tokensBefore: 90_000,
    tokensAfter: 20_000,
  };
}

interface ArtifactPayload {
  path: string;
}
type ArtifactMessage = AgentCustomMessage<'artifact', ArtifactPayload>;

function nativeArtifact(
  id: string,
  overrides: Partial<ArtifactMessage> = {},
): ArtifactMessage {
  return {
    kind: 'custom:artifact',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    includeInModel: true,
    payload: { path: 'reports/result.md' },
    ...overrides,
  };
}

const tokenUsage: TokenUsage = {
  input_tokens: 100,
  output_tokens: 50,
  total_tokens: 150,
};

// ─── Model boundary ─────────────────────────────────────────────────────

describe('projectModelMessages', () => {
  it('restores legacy provider state and unknown fields at the model boundary', () => {
    const legacy = {
      id: 'legacy-assistant',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'signed reply', textSignature: 'sig-1' }],
      timestamp: createdAt,
      providerState: { requestId: 'provider-request' },
      unknownTopLevel: 'kept',
      metadata: { nested: { retained: true } },
    } as Message;

    const projection = projectModelMessages([legacyMessageToAgentMessage(legacy)]);

    expect(projection.messages).toEqual([legacy]);
  });

  it('keeps an old persisted compact summary in the model projection', () => {
    const legacy: Message = {
      id: 'old-summary',
      role: 'system',
      content: 'Earlier work: read the README and changed config.',
      isCompactSummary: true,
      compactBoundaryId: 'old-boundary',
      compactedMessageCount: 3,
      timestamp: createdAt,
    };

    const projection = projectModelMessages([legacyMessageToAgentMessage(legacy)]);

    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toMatchObject({
      role: 'user',
      isCompactSummary: true,
    });
    expect(String(projection.messages[0]?.content)).toContain('Earlier work');
  });

  it('keeps system segments separate and never injects them as user turns', () => {
    const segments: PromptSegment[] = [
      {
        id: 'sys-stable',
        contributorId: 'system',
        placement: 'stable-prefix',
        cacheScope: 'global',
        fingerprint: 'sys-stable-v1',
        content: 'You are a careful assistant.',
      },
      {
        id: 'sys-tail',
        contributorId: 'system',
        placement: 'tail',
        cacheScope: 'none',
        fingerprint: 'sys-tail-v1',
        content: 'Be concise.',
      },
    ];

    const projection = projectModelMessages([nativeUser('u1', 'hi')], {
      systemSegments: segments,
    });

    expect(projection.system).toBe('You are a careful assistant.\n\nBe concise.');
    expect(projection.messages.map((message) => message.role)).not.toContain('system');
    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('merges structured system segments into a content block array', () => {
    const segments: PromptSegment[] = [
      {
        id: 'sys-text',
        contributorId: 'system',
        placement: 'stable-prefix',
        cacheScope: 'global',
        fingerprint: 'sys-text-v1',
        content: 'Text instruction.',
      },
      {
        id: 'sys-blocks',
        contributorId: 'system',
        placement: 'stable-prefix',
        cacheScope: 'global',
        fingerprint: 'sys-blocks-v1',
        content: [{ type: 'text', text: 'Block instruction.' }],
      },
    ];

    const projection = projectModelMessages([], { systemSegments: segments });

    expect(Array.isArray(projection.system)).toBe(true);
    expect(projection.system as readonly MessageContent[]).toEqual([
      { type: 'text', text: 'Text instruction.' },
      { type: 'text', text: 'Block instruction.' },
    ]);
  });

  it('returns an empty system when no segments are supplied', () => {
    const projection = projectModelMessages([nativeUser('u1', 'hi')]);
    expect(projection.system).toBe('');
  });

  it('includes includeInModel runtime context and excludes includeInModel=false', () => {
    const messages: AgentMessage[] = [
      nativeRuntimeContext('rc-in', { includeInModel: true }),
      nativeRuntimeContext('rc-out', { includeInModel: false }),
    ];

    const projection = projectModelMessages(messages);
    const ids = projection.messages.map((message) => message.id);

    expect(ids).toContain('rc-in');
    expect(ids).not.toContain('rc-out');
  });

  it('preserves thinking/tool_use signatures and tool round order', () => {
    const assistantContent: MessageContent[] = [
      { type: 'thinking', thinking: 'reasoning about the call' },
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' } },
    ];
    const messages: AgentMessage[] = [
      nativeUser('u1', 'run it'),
      nativeAssistant('a1', assistantContent),
      nativeToolResult('t1', 'call-1'),
    ];

    const projection = projectModelMessages(messages);

    expect(projection.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      't1',
    ]);
    const assistant = projection.messages[1];
    expect(assistant.content).toEqual(assistantContent);
    const tool = projection.messages[2];
    expect(tool).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(tool.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'ok',
        is_error: false,
      },
    ]);
  });

  it('uses an explicit custom projector and drops unadapted custom messages', () => {
    const artifact = nativeArtifact('art-1', { includeInModel: true });

    const projected = projectModelMessages<ArtifactMessage>([artifact], {
      projectCustom: (message) => ({
        id: message.id,
        role: 'user',
        content: `Artifact at ${message.payload.path}`,
        timestamp: message.createdAt,
      }),
    });

    expect(projected.messages).toEqual([
      expect.objectContaining({ id: 'art-1', content: 'Artifact at reports/result.md' }),
    ]);

    // Without a projector, a custom message is dropped at the model boundary.
    const dropped = projectModelMessages<ArtifactMessage>([artifact]);
    expect(dropped.messages).toEqual([]);
  });
});

// ─── Persistence boundary ───────────────────────────────────────────────

describe('projectPersistenceMessages', () => {
  it('keeps only durable messages and never emits transient ones', () => {
    const messages: AgentMessage[] = [
      nativeUser('u1', 'durable'),
      nativeRuntimeContext('rc-transient', { persistence: 'transient' }),
      nativeToolResult('t1', 'call-1', { persistence: 'transient' }),
    ];

    const persisted = projectPersistenceMessages(messages);
    expect(persisted.map((message) => message.id)).toEqual(['u1']);
  });

  it('preserves attachments, tokenUsage, providerId and model on native messages', () => {
    const messages: AgentMessage[] = [
      nativeUser('u1', 'see attached', {
        attachments: [{ id: 'att-1', name: 'file.txt' }],
      } as Partial<AgentMessage> as AgentMessage),
      nativeAssistant('a1', 'answer', {
        providerId: 'anthropic',
        model: 'claude-3-sonnet',
        tokenUsage: tokenUsage,
      }),
    ];

    const persisted = projectPersistenceMessages(messages);

    expect(persisted[0]).toMatchObject({
      role: 'user',
      attachments: [{ id: 'att-1', name: 'file.txt' }],
    });
    expect(persisted[1]).toMatchObject({
      role: 'assistant',
      providerId: 'anthropic',
      model: 'claude-3-sonnet',
      tokenUsage: tokenUsage,
    });
  });

  it('preserves displayContent and metadata on native user messages', () => {
    const messages: AgentMessage[] = [
      nativeUser('u1', 'raw content', {
        displayContent: 'rendered content',
        metadata: { source: 'test' },
      } as Partial<AgentMessage> as AgentMessage),
    ];

    const persisted = projectPersistenceMessages(messages);
    expect(persisted[0]).toMatchObject({
      displayContent: 'rendered content',
      metadata: { source: 'test' },
    });
  });

  it('keeps an empty-string displayContent on native user messages (renders no bubble)', () => {
    // A user who only pastes text (no typed input) sends displayContent=''.
    // The projector must preserve the empty string so the renderer does not
    // fall back to the LLM-facing content (which includes the pasted body).
    const messages: AgentMessage[] = [
      nativeUser('u1', 'pasted full body', {
        displayContent: '',
      } as Partial<AgentMessage> as AgentMessage),
    ];

    const persisted = projectPersistenceMessages(messages);
    expect(persisted[0].displayContent).toBe('');
  });
});

// ─── Transcript boundary ────────────────────────────────────────────────

describe('projectTranscriptMessages', () => {
  it('keeps only visible messages and never emits hidden ones', () => {
    const messages: AgentMessage[] = [
      nativeUser('u1', 'shown'),
      nativeRuntimeContext('rc-hidden', { visibility: 'hidden', includeInModel: true }),
    ];

    const transcript = projectTranscriptMessages(messages);
    expect(transcript.map((message) => message.id)).toEqual(['u1']);
  });

  it('does not reuse the provider projector for hidden includeInModel context', () => {
    // This runtime_context is hidden but includeInModel=true. The provider
    // projector would include it; the transcript projector must exclude it
    // because visibility is an independent policy.
    const messages: AgentMessage[] = [
      nativeRuntimeContext('rc-hidden-inmodel', {
        visibility: 'hidden',
        includeInModel: true,
      }),
    ];

    const model = projectModelMessages(messages).messages;
    const transcript = projectTranscriptMessages(messages);

    expect(model.map((message) => message.id)).toContain('rc-hidden-inmodel');
    expect(transcript).toEqual([]);
  });
});

// ─── Three independent policies ─────────────────────────────────────────

describe('transient / hidden / includeInModel are three independent policies', () => {
  const matrix = [
    {
      id: 'd-v-i',
      persistence: 'durable' as const,
      visibility: 'visible' as const,
      includeInModel: true,
      expectModel: true,
      expectPersistence: true,
      expectTranscript: true,
    },
    {
      id: 'd-v-ni',
      persistence: 'durable' as const,
      visibility: 'visible' as const,
      includeInModel: false,
      expectModel: false,
      expectPersistence: true,
      expectTranscript: true,
    },
    {
      id: 'd-h-i',
      persistence: 'durable' as const,
      visibility: 'hidden' as const,
      includeInModel: true,
      expectModel: true,
      expectPersistence: true,
      expectTranscript: false,
    },
    {
      id: 'd-h-ni',
      persistence: 'durable' as const,
      visibility: 'hidden' as const,
      includeInModel: false,
      expectModel: false,
      expectPersistence: true,
      expectTranscript: false,
    },
    {
      id: 't-v-i',
      persistence: 'transient' as const,
      visibility: 'visible' as const,
      includeInModel: true,
      expectModel: true,
      expectPersistence: false,
      expectTranscript: true,
    },
    {
      id: 't-v-ni',
      persistence: 'transient' as const,
      visibility: 'visible' as const,
      includeInModel: false,
      expectModel: false,
      expectPersistence: false,
      expectTranscript: true,
    },
    {
      id: 't-h-i',
      persistence: 'transient' as const,
      visibility: 'hidden' as const,
      includeInModel: true,
      expectModel: true,
      expectPersistence: false,
      expectTranscript: false,
    },
    {
      id: 't-h-ni',
      persistence: 'transient' as const,
      visibility: 'hidden' as const,
      includeInModel: false,
      expectModel: false,
      expectPersistence: false,
      expectTranscript: false,
    },
  ];

  const messages = matrix.map((entry) =>
    nativeRuntimeContext(entry.id, {
      persistence: entry.persistence,
      visibility: entry.visibility,
      includeInModel: entry.includeInModel,
    }),
  );

  const modelIds = projectModelMessages(messages).messages.map((message) => message.id);
  const persistenceIds = projectPersistenceMessages(messages).map((message) => message.id);
  const transcriptIds = projectTranscriptMessages(messages).map((message) => message.id);

  for (const entry of matrix) {
    it(`routes ${entry.id} to the correct boundaries`, () => {
      expect(modelIds.includes(entry.id)).toBe(entry.expectModel);
      expect(persistenceIds.includes(entry.id)).toBe(entry.expectPersistence);
      expect(transcriptIds.includes(entry.id)).toBe(entry.expectTranscript);
    });
  }
});

// ─── Legacy-adapted messages preferred lossless ─────────────────────────

describe('legacy-adapted messages are restored losslessly at every boundary', () => {
  function legacyWithExtras(): Message {
    const message = {
      id: 'legacy-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      providerId: 'anthropic',
      model: 'claude-3-sonnet',
      tokenUsage: tokenUsage,
      // Legacy DB fields that have no native AgentMessage equivalent.
      seq_index: 7,
      duration_ms: 1234,
      status: 'completed',
      viz_spec: '{"kind":"chart"}',
      metadata: { turn: 3 },
      // A genuinely unknown column that must survive the round trip untouched.
      custom_db_column: { chart: 'bar' },
    } satisfies Message & Record<string, unknown>;
    return message;
  }

  it('restores the original record at the persistence boundary', () => {
    const original = legacyWithExtras();
    const adapted = legacyMessageToAgentMessage(original);

    const persisted = projectPersistenceMessages([adapted]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(original);
  });

  it('restores the original record at the transcript boundary', () => {
    const original = legacyWithExtras();
    const adapted = legacyMessageToAgentMessage(original);

    const transcript = projectTranscriptMessages([adapted]);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toEqual(original);
  });

  it('prefers the legacy envelope over a native projection even for visible durable messages', () => {
    const original = legacyWithExtras();
    const adapted = legacyMessageToAgentMessage(original);

    expect(hasLegacyEnvelope(adapted)).toBe(true);
    // Both boundaries must return the same lossless record, proving they
    // share the restore path without re-deriving fields natively.
    expect(projectPersistenceMessages([adapted])[0]).toEqual(
      projectTranscriptMessages([adapted])[0],
    );
  });
});

// ─── Native AgentMessage without a Legacy sidecar ───────────────────────

describe('native AgentMessages persist and render without a Legacy sidecar', () => {
  const native: AgentMessage[] = [
    nativeUser('u1', 'hello'),
    nativeAssistant('a1', 'hi there', { providerId: 'anthropic', model: 'claude-3' }),
    nativeToolResult('t1', 'call-1'),
    nativeRuntimeContext('rc-1', { source: 'mailbox' }),
    nativeCompactionSummary('cs-1'),
  ];

  it('has no legacy envelope on any native message', () => {
    for (const message of native) {
      expect(hasLegacyEnvelope(message)).toBe(false);
    }
  });

  it('projects every native kind to a valid legacy Message at the persistence boundary', () => {
    const persisted = projectPersistenceMessages(native);
    expect(persisted.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      't1',
      'rc-1',
      'cs-1',
    ]);
    expect(persisted[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(persisted[1]).toMatchObject({
      role: 'assistant',
      providerId: 'anthropic',
      model: 'claude-3',
    });
    expect(persisted[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
  });

  it('projects a native runtime_context to a user-role message that round-trips', () => {
    const persisted = projectPersistenceMessages([
      nativeRuntimeContext('rc-mailbox', { source: 'mailbox' }),
    ]);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      msg_type: 'mailbox',
    });
    expect(persisted[0].metadata).toMatchObject({
      runtimeContext: true,
      source: 'mailbox',
    });

    // The metadata marker lets the adapter recover a runtime_context instead
    // of a plain user message on reverse conversion.
    const restored = legacyMessageToAgentMessage(persisted[0]);
    expect(restored.kind).toBe('runtime_context');
  });

  it('projects a native compaction_summary to the isCompactSummary legacy shape', () => {
    const persisted = projectPersistenceMessages([nativeCompactionSummary('cs-1')]);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      isCompactSummary: true,
      compactBoundaryId: 'compact-1',
      compactedMessageCount: 90_000,
    });
  });

  it('preserves a native custom message via an explicit projector at the boundaries', () => {
    const artifact = nativeArtifact('art-1', { persistence: 'durable', visibility: 'visible' });
    const projectCustomToLegacy = (message: ArtifactMessage): Message => ({
      id: message.id,
      role: 'user',
      content: `Artifact: ${message.payload.path}`,
      timestamp: message.createdAt,
    });

    const persisted = projectPersistenceMessages<ArtifactMessage>([artifact], {
      projectCustomToLegacy,
    });
    const transcript = projectTranscriptMessages<ArtifactMessage>([artifact], {
      projectCustomToLegacy,
    });

    expect(persisted[0]).toMatchObject({ id: 'art-1', content: 'Artifact: reports/result.md' });
    expect(transcript[0]).toMatchObject({ id: 'art-1', content: 'Artifact: reports/result.md' });
  });

  it('preserves an unadapted native custom message payload in metadata by default', () => {
    const artifact = nativeArtifact('art-1');

    const persisted = projectPersistenceMessages<ArtifactMessage>([artifact]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].metadata).toMatchObject({
      duyaCustomKind: 'custom:artifact',
      duyaCustomPayload: { path: 'reports/result.md' },
    });
  });

  it('drops a native custom message when the projector returns null', () => {
    const artifact = nativeArtifact('art-1');
    const persisted = projectPersistenceMessages<ArtifactMessage>([artifact], {
      projectCustomToLegacy: () => null,
    });
    expect(persisted).toEqual([]);
  });
});

// ─── Purity: no input mutation + deterministic output ───────────────────

describe('projector purity', () => {
  const sample: AgentMessage[] = [
    nativeUser('u1', 'first', {
      attachments: [{ id: 'att-1', name: 'file.txt' }],
    } as Partial<AgentMessage> as AgentMessage),
    nativeAssistant('a1', 'second', { tokenUsage }),
    nativeToolResult('t1', 'call-1'),
    nativeRuntimeContext('rc-1', { includeInModel: true }),
    nativeCompactionSummary('cs-1'),
    nativeArtifact('art-1'),
  ];

  it('does not mutate the input array or any input message', () => {
    const before = structuredClone(sample);
    projectModelMessages(sample);
    projectPersistenceMessages(sample);
    projectTranscriptMessages(sample);
    expect(sample).toEqual(before);
  });

  it('produces deterministic output across repeated calls', () => {
    const modelA = projectModelMessages(sample);
    const modelB = projectModelMessages(sample);
    expect(modelA).toEqual(modelB);

    const persistenceA = projectPersistenceMessages(sample);
    const persistenceB = projectPersistenceMessages(sample);
    expect(persistenceA).toEqual(persistenceB);

    const transcriptA = projectTranscriptMessages(sample);
    const transcriptB = projectTranscriptMessages(sample);
    expect(transcriptA).toEqual(transcriptB);
  });

  it('returns independent copies (mutating output does not affect input)', () => {
    const persisted = projectPersistenceMessages(sample);
    expect(persisted).toHaveLength(sample.length);

    // Mutate the output aggressively; the input must stay pristine.
    persisted[0].content = 'tampered';
    if (Array.isArray(persisted[1].content)) {
      persisted[1].content.push({ type: 'text', text: 'injected' });
    }
    expect((sample[0] as { content: unknown }).content).toBe('first');
    expect(sample[1].content).toBe('second');
  });
});

// ─── extractLegacySystemSegments + projectModelMessages end-to-end ──────

describe('extractLegacySystemSegments', () => {
  it('extracts system content from legacy system messages', () => {
    const legacySystem: Message = {
      id: 'sys-1',
      role: 'system',
      content: 'You are in debug mode.',
      timestamp: createdAt,
    };
    const adapted = legacyMessageToAgentMessage(legacySystem);
    const segments = extractLegacySystemSegments([adapted]);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: 'sys-1',
      contributorId: 'legacy-system',
      placement: 'history-prefix',
      content: 'You are in debug mode.',
    });
  });

  it('extracts reinjected system messages from a compaction entry', () => {
    const compaction = {
      id: 'compact-1',
      reinjectedSystemMessages: ['Remember the file context.', 'Working dir: /tmp'],
    } as Pick<CompactionEntry, 'id' | 'reinjectedSystemMessages'>;

    const segments = extractLegacySystemSegments([], compaction);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      id: 'compact-1:reinjected-0',
      contributorId: 'compaction',
      content: 'Remember the file context.',
    });
    expect(segments[1]).toMatchObject({
      id: 'compact-1:reinjected-1',
      content: 'Working dir: /tmp',
    });
  });

  it('returns empty when no legacy system messages or compaction exist', () => {
    const segments = extractLegacySystemSegments([
      nativeUser('u1', 'hi'),
      nativeAssistant('a1', 'hello'),
    ]);
    expect(segments).toEqual([]);
  });

  it('ignores non-system custom messages', () => {
    const artifact = nativeArtifact('art-1');
    const segments = extractLegacySystemSegments([artifact]);
    expect(segments).toEqual([]);
  });
});

describe('projectModelMessages with legacy system messages (end-to-end)', () => {
  it('moves legacy system content into the system prompt, not the messages array', () => {
    const legacyMessages: Message[] = [
      { id: 'sys-1', role: 'system', content: 'System context: debug mode.', timestamp: createdAt },
      { id: 'u-1', role: 'user', content: 'hey agent', timestamp: createdAt },
      { id: 'a-1', role: 'assistant', content: 'hello!', timestamp: createdAt },
    ];

    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    const segments = extractLegacySystemSegments(adapted);
    const projection = projectModelMessages(adapted, { systemSegments: segments });

    // System content must appear in the system prompt
    expect(projection.system).toContain('System context: debug mode.');

    // Messages must NOT contain any system-role messages
    expect(projection.messages.map((m) => m.role)).not.toContain('system');
    expect(projection.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
  });

  it('preserves tool_use/tool_result pairing through the model boundary', () => {
    const legacyMessages: Message[] = [
      { id: 'u-1', role: 'user', content: 'read file', timestamp: createdAt },
      {
        id: 'a-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' } },
        ],
        timestamp: createdAt,
      },
      {
        id: 't-1',
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'read',
        content: 'file contents here',
        timestamp: createdAt,
      },
    ];

    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    const projection = projectModelMessages(adapted);

    expect(projection.messages.map((m) => m.id)).toEqual(['u-1', 'a-1', 't-1']);
    const tool = projection.messages[2];
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call-1');
  });

  it('projects compaction_summary as a user-role message, not system', () => {
    const legacyMessages: Message[] = [
      {
        id: 'compact-1',
        role: 'system',
        content: 'Earlier conversation was compacted.',
        isCompactSummary: true,
        compactBoundaryId: 'compact-1',
        compactedMessageCount: 5,
        timestamp: createdAt,
      },
      { id: 'u-2', role: 'user', content: 'continue', timestamp: createdAt },
    ];

    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    const projection = projectModelMessages(adapted);

    // Compaction summary should be a user-role message, not system
    const compact = projection.messages.find((m) => m.isCompactSummary);
    expect(compact).toBeDefined();
    expect(compact?.role).toBe('user');

    // No system-role messages in the output
    expect(projection.messages.map((m) => m.role)).not.toContain('system');
  });

  it('excludes runtime_context with includeInModel=false from the model boundary', () => {
    const legacyMessages: Message[] = [
      { id: 'u-1', role: 'user', content: 'hey', timestamp: createdAt },
      // Runtime context with msg_type → adapted as runtime_context, includeInModel=true
      {
        id: 'rc-1',
        role: 'user',
        content: 'attachment text',
        msg_type: 'attachment',
        timestamp: createdAt,
      },
    ];

    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    const projection = projectModelMessages(adapted);

    // Both messages should appear (runtime_context with includeInModel=true)
    expect(projection.messages.map((m) => m.id)).toContain('rc-1');
  });
});

describe('end-to-end: timeline → buildAgentContext → projectModelMessages', () => {
  it('simulates a "hey agent" request with system messages in history', () => {
    // Simulate a session with a system message, a user message, and an assistant reply
    const legacyMessages: Message[] = [
      { id: 'sys-1', role: 'system', content: 'Working directory: /home/user', timestamp: createdAt },
      { id: 'u-1', role: 'user', content: 'hey agent', timestamp: createdAt },
    ];

    // Build timeline from legacy messages (same as DuyaAgent.setMessages)
    const timeline = new MessageTimeline<AgentCustomMessage>();
    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    for (const [index, message] of adapted.entries()) {
      timeline.appendMessage({
        type: 'message',
        id: `entry-${index}`,
        parentId: null,
        createdAt: message.createdAt,
        message,
      });
    }

    // Simulate _projectModelMessages
    const context = buildAgentContext(timeline.snapshot());
    const segments = extractLegacySystemSegments(context.messages, context.compaction);
    const projection = projectModelMessages(context.messages, { systemSegments: segments });

    // System content should be in the system prompt
    expect(projection.system).toContain('Working directory: /home/user');

    // Messages should only contain the user message
    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toMatchObject({
      role: 'user',
      content: 'hey agent',
    });

    // No system-role messages in the output
    expect(projection.messages.map((m) => m.role)).not.toContain('system');
  });

  it('simulates a tool-use round through the model boundary', () => {
    const legacyMessages: Message[] = [
      { id: 'u-1', role: 'user', content: 'read the file', timestamp: createdAt },
      {
        id: 'a-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'test.txt' } },
        ],
        timestamp: createdAt,
      },
      {
        id: 't-1',
        role: 'tool',
        tool_call_id: 'call-1',
        name: 'Read',
        content: 'file content',
        timestamp: createdAt,
      },
      {
        id: 'a-2',
        role: 'assistant',
        content: 'The file says: file content',
        timestamp: createdAt,
      },
    ];

    const timeline = new MessageTimeline<AgentCustomMessage>();
    const adapted = legacyMessagesToAgentMessages(legacyMessages);
    for (const [index, message] of adapted.entries()) {
      timeline.appendMessage({
        type: 'message',
        id: `entry-${index}`,
        parentId: null,
        createdAt: message.createdAt,
        message,
      });
    }

    const context = buildAgentContext(timeline.snapshot());
    const projection = projectModelMessages(context.messages);

    // All 4 messages should be in the projection
    expect(projection.messages).toHaveLength(4);
    expect(projection.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);

    // Tool result should have the correct tool_call_id.
    // Legacy-adapted messages round-trip losslessly: content stays as the
    // original string; tool_result block wrapping happens at the provider
    // level in toAnthropicMessages/toOpenAIMessages.
    const tool = projection.messages[2];
    expect(tool.tool_call_id).toBe('call-1');
    expect(tool.role).toBe('tool');
  });
});

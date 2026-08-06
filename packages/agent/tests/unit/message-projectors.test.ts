import { describe, expect, it } from 'vitest';
import type { Message, MessageContent, TokenUsage } from '../../src/types.js';
import type {
  AgentMessage,
  PromptSegment,
  RuntimeContextSource,
} from '../../src/message/message-framework.js';
import { ingestMessage } from '../../src/message/message-factories.js';
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
import { projectTimelinePersistenceMessages } from '../../src/message/index.js';
import { ingestMessages } from '../../src/message/message-factories.js';
import { MessageTimeline } from '../../src/message/message-framework.js';

const createdAt = 1_700_000_000_000;

// ─── Native message builders (no Legacy sidecar) ────────────────────────

function nativeUser(
  id: string,
  content: string,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    role: 'user',
    id,
    timestamp: createdAt,
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
    role: 'assistant',
    id,
    timestamp: createdAt,
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
  const content: MessageContent[] = [
    {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: 'ok',
      is_error: false,
    },
  ];
  return {
    role: 'tool',
    id,
    timestamp: createdAt,
    visibility: 'visible',
    name: 'read',
    tool_call_id: toolCallId,
    content,
    ...overrides,
  };
}

function nativeRuntimeContext(
  id: string,
  overrides: {
    visibility?: 'visible' | 'hidden';
    source?: RuntimeContextSource;
    content?: string;
  } = {},
): AgentMessage {
  return {
    role: 'runtime_context',
    id,
    timestamp: createdAt,
    visibility: 'visible',
    source: 'custom',
    content: 'ctx',
    ...overrides,
  } as AgentMessage;
}

function nativeCompactionSummary(id: string): AgentMessage {
  return {
    role: 'compaction_summary',
    id,
    timestamp: createdAt,
    visibility: 'visible',
    summary: 'Earlier work was compacted.',
    compactionEntryId: 'compact-1',
    tokensBefore: 90_000,
    tokensAfter: 20_000,
  };
}

const tokenUsage: TokenUsage = {
  input_tokens: 100,
  output_tokens: 50,
  total_tokens: 150,
};

// ─── Model boundary ─────────────────────────────────────────────────────

describe('projectModelMessages', () => {
  it('projects a legacy assistant message through the AgentMessage shape at the model boundary', () => {
    const legacy = {
      id: 'legacy-assistant',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'signed reply', textSignature: 'sig-1' }],
      timestamp: createdAt,
      providerState: { requestId: 'provider-request' },
      unknownTopLevel: 'kept',
      metadata: { nested: { retained: true } },
    } as Message;

    const projection = projectModelMessages([ingestMessage(legacy)]);

    expect(projection.messages).toHaveLength(1);
    // Phase 1: the model boundary projects from the AgentMessage shape without
    // the legacy envelope. Modeled fields (content, role, id, timestamp,
    // metadata, content-block signatures) survive; envelope-only arbitrary
    // fields (providerState, unknownTopLevel) never reach the model.
    expect(projection.messages[0]).toMatchObject({
      id: 'legacy-assistant',
      role: 'assistant',
      content: [{ type: 'text' as const, text: 'signed reply', textSignature: 'sig-1' }],
      timestamp: createdAt,
      metadata: { nested: { retained: true } },
    });
    const serialized = JSON.stringify(projection.messages[0]);
    expect(serialized).not.toContain('provider-request');
    expect(serialized).not.toContain('unknownTopLevel');
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

    const projection = projectModelMessages([ingestMessage(legacy)]);

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

  it('includes every runtime_context at the model boundary regardless of visibility', () => {
    const messages: AgentMessage[] = [
      nativeRuntimeContext('rc-in', { visibility: 'visible' }),
      nativeRuntimeContext('rc-out', { visibility: 'hidden' }),
    ];

    const projection = projectModelMessages(messages);
    const ids = projection.messages.map((message) => message.id);

    // The model boundary is independent of visibility: both runtime context
    // turns are projected as user-role messages.
    expect(ids).toContain('rc-in');
    expect(ids).toContain('rc-out');
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

});

// ─── Persistence boundary ───────────────────────────────────────────────

describe('projectPersistenceMessages', () => {
  it('keeps every native message at the persistence boundary (no transient category)', () => {
    const messages: AgentMessage[] = [
      nativeUser('u1', 'durable'),
      nativeRuntimeContext('rc-hidden', { visibility: 'hidden' }),
      nativeToolResult('t1', 'call-1'),
    ];

    const persisted = projectPersistenceMessages(messages);
    expect(persisted.map((message) => message.id)).toEqual(['u1', 'rc-hidden', 't1']);
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
      nativeRuntimeContext('rc-hidden', { visibility: 'hidden' }),
    ];

    const transcript = projectTranscriptMessages(messages);
    expect(transcript.map((message) => message.id)).toEqual(['u1']);
  });

  it('does not reuse the model projector for hidden runtime context', () => {
    // This runtime_context is hidden. The provider projector would include it;
    // the transcript projector must exclude it because visibility is an
    // independent policy owned by the transcript boundary.
    const messages: AgentMessage[] = [
      nativeRuntimeContext('rc-hidden', { visibility: 'hidden' }),
    ];

    const model = projectModelMessages(messages).messages;
    const transcript = projectTranscriptMessages(messages);

    expect(model.map((message) => message.id)).toContain('rc-hidden');
    expect(transcript).toEqual([]);
  });
});

// ─── Visibility is the only independent policy ─────────────────────────

describe('visibility drives the transcript boundary independently of model/persistence', () => {
  const matrix = [
    {
      id: 'v-visible',
      visibility: 'visible' as const,
      expectModel: true,
      expectPersistence: true,
      expectTranscript: true,
    },
    {
      id: 'v-hidden',
      visibility: 'hidden' as const,
      expectModel: true,
      expectPersistence: true,
      expectTranscript: false,
    },
  ];

  const messages = matrix.map((entry) =>
    nativeRuntimeContext(entry.id, {
      visibility: entry.visibility,
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

// ─── Legacy-adapted messages restored via the native projection ─────────

describe('legacy-adapted messages are restored losslessly via the native projection', () => {
  function legacyWithExtras(): Message {
    const message = {
      id: 'legacy-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      providerId: 'anthropic',
      model: 'claude-3-sonnet',
      tokenUsage: tokenUsage,
      // Legacy DB columns that the native projection now carries.
      seq_index: 7,
      duration_ms: 1234,
      status: 'completed',
      viz_spec: '{"kind":"chart"}',
      metadata: { turn: 3 },
    } satisfies Message & Record<string, unknown>;
    return message;
  }

  it('restores the original record at the persistence boundary', () => {
    const original = legacyWithExtras();
    const adapted = ingestMessage(original);

    const persisted = projectPersistenceMessages([adapted]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject(original);
  });

  it('restores the original record at the transcript boundary', () => {
    const original = legacyWithExtras();
    const adapted = ingestMessage(original);

    const transcript = projectTranscriptMessages([adapted]);
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject(original);
  });

  it('reproduces the same lossless record at both boundaries via the native path', () => {
    const original = legacyWithExtras();
    const adapted = ingestMessage(original);

    // Both boundaries share the native projection and must return the same
    // record without re-deriving fields from the envelope.
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
    const restored = ingestMessage(persisted[0]);
    expect(restored.role).toBe('runtime_context');
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
});

// ─── Purity: no input mutation + deterministic output ───────────────────

describe('projector purity', () => {
  const sample: AgentMessage[] = [
    nativeUser('u1', 'first', {
      attachments: [{ id: 'att-1', name: 'file.txt' }],
    } as Partial<AgentMessage> as AgentMessage),
    nativeAssistant('a1', 'second', { tokenUsage }),
    nativeToolResult('t1', 'call-1'),
    nativeRuntimeContext('rc-1'),
    nativeCompactionSummary('cs-1'),
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
    const adapted = ingestMessage(legacySystem);
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
});

describe('projectModelMessages with legacy system messages (end-to-end)', () => {
  it('moves legacy system content into the system prompt, not the messages array', () => {
    const legacyMessages: Message[] = [
      { id: 'sys-1', role: 'system', content: 'System context: debug mode.', timestamp: createdAt },
      { id: 'u-1', role: 'user', content: 'hey agent', timestamp: createdAt },
      { id: 'a-1', role: 'assistant', content: 'hello!', timestamp: createdAt },
    ];

    const adapted = ingestMessages(legacyMessages);
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

    const adapted = ingestMessages(legacyMessages);
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

    const adapted = ingestMessages(legacyMessages);
    const projection = projectModelMessages(adapted);

    // Compaction summary should be a user-role message, not system
    const compact = projection.messages.find((m) => m.isCompactSummary);
    expect(compact).toBeDefined();
    expect(compact?.role).toBe('user');

    // No system-role messages in the output
    expect(projection.messages.map((m) => m.role)).not.toContain('system');
  });

  it('includes a runtime_context adapted from a msg_type row at the model boundary', () => {
    const legacyMessages: Message[] = [
      { id: 'u-1', role: 'user', content: 'hey', timestamp: createdAt },
      // Runtime context with msg_type → adapted as role='runtime_context'
      {
        id: 'rc-1',
        role: 'user',
        content: 'attachment text',
        msg_type: 'attachment',
        timestamp: createdAt,
      },
    ];

    const adapted = ingestMessages(legacyMessages);

    // The adapted runtime_context stays a runtime_context (not a plain user).
    const rc = adapted.find((m) => m.id === 'rc-1');
    expect(rc?.role).toBe('runtime_context');

    const projection = projectModelMessages(adapted);

    // Both messages appear; the runtime_context is projected as a user turn.
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
    const timeline = new MessageTimeline();
    const adapted = ingestMessages(legacyMessages);
    for (const [index, message] of adapted.entries()) {
      timeline.appendMessage({
        type: 'message',
        id: `entry-${index}`,
        parentId: null,
        createdAt: message.timestamp,
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

    const timeline = new MessageTimeline();
    const adapted = ingestMessages(legacyMessages);
    for (const [index, message] of adapted.entries()) {
      timeline.appendMessage({
        type: 'message',
        id: `entry-${index}`,
        parentId: null,
        createdAt: message.timestamp,
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

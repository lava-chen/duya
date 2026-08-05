import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import {
  MessageTimeline,
  buildAgentContext,
  findSafeCompactionBoundary,
  isDurableAgentMessage,
  isVisibleAgentMessage,
  toModelMessages,
  type AgentCustomMessage,
  type AgentMessage,
  type CompactionEntry,
  type MessageEntry,
} from '../../src/message/message-framework.js';

const createdAt = 1_700_000_000_000;

function user(id: string, content: string): AgentMessage {
  return {
    kind: 'user',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function assistant(id: string, content: string): AgentMessage {
  return {
    kind: 'assistant',
    id,
    createdAt,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function toolResult(id: string, toolCallId: string): AgentMessage {
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
  };
}

function messageEntry(
  id: string,
  message: AgentMessage,
  parentId: string | null = null,
): MessageEntry {
  return { type: 'message', id, parentId, createdAt, message };
}

function compactionEntry(
  id: string,
  firstKeptMessageId: string,
): CompactionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    createdAt,
    summary: 'The earlier work is complete.',
    firstKeptMessageId,
    compactedMessageIds: ['u1', 'a1'],
    tokensBefore: 90_000,
    tokensAfter: 20_000,
    strategy: 'session_memory',
  };
}

describe('MessageTimeline', () => {
  it('keeps append order and rejects duplicate entry ids', () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('entry-u1', user('u1', 'first')));
    timeline.appendMessage(messageEntry('entry-a1', assistant('a1', 'second')));

    expect(timeline.snapshot().map((entry) => entry.id)).toEqual([
      'entry-u1',
      'entry-a1',
    ]);
    expect(() => {
      timeline.appendMessage(messageEntry('entry-u1', user('u2', 'duplicate')));
    }).toThrow('Duplicate timeline entry id');
  });

  it('rejects duplicate message ids even when entry ids differ', () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('entry-u1', user('u1', 'first')));

    expect(() => {
      timeline.appendMessage(messageEntry('entry-u1-copy', user('u1', 'copy')));
    }).toThrow('Duplicate agent message id');
  });
});

describe('message policy helpers', () => {
  it('separates durability from UI visibility', () => {
    const runtimeMessage: AgentMessage = {
      kind: 'runtime_context',
      id: 'mailbox-1',
      createdAt,
      persistence: 'transient',
      visibility: 'hidden',
      source: 'mailbox',
      content: 'Continue with the new instruction.',
      includeInModel: true,
    };

    expect(isDurableAgentMessage(runtimeMessage)).toBe(false);
    expect(isVisibleAgentMessage(runtimeMessage)).toBe(false);
    expect(toModelMessages([runtimeMessage])).toHaveLength(1);
  });
});

describe('compaction projection', () => {
  it('keeps the ledger intact and projects the latest summary plus suffix', () => {
    const entries = [
      messageEntry('entry-u1', user('u1', 'old request')),
      messageEntry('entry-a1', assistant('a1', 'old answer')),
      messageEntry('entry-u2', user('u2', 'kept request')),
      messageEntry('entry-a2', assistant('a2', 'kept answer')),
      compactionEntry('compact-1', 'u2'),
      messageEntry('entry-u3', user('u3', 'new request')),
    ];

    const projection = buildAgentContext(entries);

    expect(entries).toHaveLength(6);
    expect(projection.warnings).toEqual([]);
    expect(projection.messages.map((message) => message.id)).toEqual([
      'compact-1:summary',
      'u2',
      'a2',
      'u3',
    ]);
    expect(toModelMessages(projection.messages)[0]).toMatchObject({
      role: 'user',
      isCompactSummary: true,
      compactBoundaryId: 'compact-1',
    });
  });

  it('retains full history when a compaction boundary is invalid', () => {
    const entries = [
      messageEntry('entry-u1', user('u1', 'request')),
      compactionEntry('compact-1', 'missing-message'),
    ];

    const projection = buildAgentContext(entries);

    expect(projection.messages.map((message) => message.id)).toEqual(['u1']);
    expect(projection.warnings[0]).toContain('full history retained');
  });

  it('uses only the latest checkpoint across repeated long-running compactions', () => {
    const firstCompaction = compactionEntry('compact-1', 'u2');
    const secondCompaction = {
      ...compactionEntry('compact-2', 'u3'),
      summary: 'The first summary and subsequent work are consolidated.',
      previousCompactionId: 'compact-1',
    };
    const entries = [
      messageEntry('entry-u1', user('u1', 'old request')),
      messageEntry('entry-a1', assistant('a1', 'old answer')),
      messageEntry('entry-u2', user('u2', 'first kept request')),
      firstCompaction,
      messageEntry('entry-a2', assistant('a2', 'continued answer')),
      messageEntry('entry-u3', user('u3', 'latest kept request')),
      messageEntry('entry-a3', assistant('a3', 'latest answer')),
      secondCompaction,
      messageEntry('entry-u4', user('u4', 'new work')),
    ];

    const projection = buildAgentContext(entries);

    expect(projection.compaction?.id).toBe('compact-2');
    expect(projection.messages.map((message) => message.id)).toEqual([
      'compact-2:summary',
      'u3',
      'a3',
      'u4',
    ]);
  });

  it('moves a proposed cut back to a user turn boundary', () => {
    const messages = [
      user('u1', 'first'),
      assistant('a1', 'tool call'),
      toolResult('t1', 'call-1'),
      assistant('a2', 'tool follow-up'),
      user('u2', 'second'),
      assistant('a3', 'answer'),
    ];

    expect(findSafeCompactionBoundary(messages, 3)).toEqual({
      firstKeptIndex: 0,
      firstKeptMessageId: 'u1',
    });
    expect(findSafeCompactionBoundary(messages, 5)).toEqual({
      firstKeptIndex: 4,
      firstKeptMessageId: 'u2',
    });
  });
});

describe('custom message projection', () => {
  interface ArtifactPayload {
    path: string;
  }

  type ArtifactMessage = AgentCustomMessage<'artifact', ArtifactPayload>;

  it('uses an explicit adapter only at the model boundary', () => {
    const artifact: ArtifactMessage = {
      kind: 'custom:artifact',
      id: 'artifact-1',
      createdAt,
      persistence: 'durable',
      visibility: 'visible',
      includeInModel: true,
      payload: { path: 'reports/result.md' },
    };

    const projected = toModelMessages<ArtifactMessage>([artifact], (message) => ({
      id: message.id,
      role: 'user',
      content: `Artifact available at ${message.payload.path}`,
      timestamp: message.createdAt,
    } satisfies Message));

    expect(projected).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'Artifact available at reports/result.md',
      }),
    ]);
  });

  it('does not leak an unadapted custom message into provider context', () => {
    const artifact: ArtifactMessage = {
      kind: 'custom:artifact',
      id: 'artifact-1',
      createdAt,
      persistence: 'durable',
      visibility: 'visible',
      includeInModel: true,
      payload: { path: 'reports/result.md' },
    };

    expect(toModelMessages<ArtifactMessage>([artifact])).toEqual([]);
  });
});

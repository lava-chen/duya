import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import {
  MessageTimeline,
  buildAgentContext,
  buildCachePlan,
  buildModelContextSnapshot,
  findSafeCompactionBoundary,
  isDurableAgentMessage,
  isVisibleAgentMessage,
  toModelMessages,
  type AppliedContextContribution,
  type AgentCustomMessage,
  type AgentMessage,
  type CompactionEntry,
  type ContextContributor,
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

describe('model context snapshot', () => {
  interface TestToolDefinition {
    name: string;
  }

  interface TestContext {
    projectId: string;
  }

  it('places contributions deterministically without turning tools into messages', async () => {
    const projection = {
      messages: [
        user('u1', 'earlier request'),
        assistant('a1', 'earlier answer'),
        user('u2', 'current request'),
      ],
      warnings: [],
    };
    const contextContributor = {
      id: 'context',
      order: 10,
      collect: () => [
        {
          id: 'tail-message',
          target: 'messages',
          placement: 'tail',
          cacheScope: 'turn',
          fingerprint: 'tail-v1',
          messages: [user('ctx-tail', 'tail context')],
        },
        {
          id: 'metadata',
          target: 'metadata',
          placement: 'history-prefix',
          cacheScope: 'session',
          fingerprint: 'metadata-v1',
          metadata: { mode: 'plan-task' },
        },
        {
          id: 'before-user',
          target: 'messages',
          placement: 'before-current-user',
          cacheScope: 'turn',
          fingerprint: 'before-v1',
          messages: [user('ctx-before', 'before current user')],
        },
        {
          id: 'stable-message',
          target: 'messages',
          placement: 'stable-prefix',
          cacheScope: 'project',
          fingerprint: 'stable-message-v1',
          messages: [user('ctx-stable', 'stable context')],
        },
        {
          id: 'history-message',
          target: 'messages',
          placement: 'history-prefix',
          cacheScope: 'session',
          fingerprint: 'history-v1',
          messages: [user('ctx-history', 'history context')],
        },
        {
          id: 'system-tail',
          target: 'system',
          placement: 'tail',
          cacheScope: 'none',
          fingerprint: 'system-tail-v1',
          content: 'Volatile system instruction',
        },
      ],
    } satisfies ContextContributor<never, TestToolDefinition, TestContext>;
    const toolContributor = {
      id: 'tools',
      order: 0,
      collect: () => [
        {
          id: 'tool-surface',
          target: 'tools',
          placement: 'stable-prefix',
          cacheScope: 'global',
          fingerprint: 'tools-v1',
          tools: [
            {
              id: 'mcp:search',
              source: 'mcp',
              fingerprint: 'mcp-search-v1',
              definition: { name: 'mcp_search' },
            },
            {
              id: 'builtin:read',
              source: 'builtin',
              fingerprint: 'builtin-read-v1',
              definition: { name: 'read' },
            },
          ],
        },
        {
          id: 'system-stable',
          target: 'system',
          placement: 'stable-prefix',
          cacheScope: 'global',
          fingerprint: 'system-v1',
          content: 'Stable system instruction',
        },
      ],
    } satisfies ContextContributor<never, TestToolDefinition, TestContext>;

    const snapshot = await buildModelContextSnapshot(
      projection,
      [contextContributor, toolContributor],
      { requestId: 'request-1', context: { projectId: 'project-1' } },
    );

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'ctx-stable',
      'ctx-history',
      'u1',
      'a1',
      'ctx-before',
      'u2',
      'ctx-tail',
    ]);
    expect(snapshot.systemSegments.map((segment) => segment.id)).toEqual([
      'system-stable',
      'system-tail',
    ]);
    expect(snapshot.metadataSegments).toEqual([
      expect.objectContaining({ id: 'metadata', metadata: { mode: 'plan-task' } }),
    ]);
    expect(snapshot.tools.items.map((tool) => tool.id)).toEqual([
      'builtin:read',
      'mcp:search',
    ]);
    expect(snapshot.messages.some((message) => message.id === 'mcp:search')).toBe(false);
    expect(snapshot.cachePlan.entries.map((entry) => entry.cacheScope)).toEqual([
      'global',
      'project',
      'global',
      'session',
      'session',
      'turn',
      'turn',
    ]);
  });

  it('builds the same cache plan regardless of input order and excludes none scope', () => {
    const contributions: AppliedContextContribution[] = [
      {
        key: 'turn:mailbox',
        contributorId: 'turn',
        contributionId: 'mailbox',
        target: 'messages',
        placement: 'tail',
        cacheScope: 'turn',
        fingerprint: 'mailbox-v1',
        contributorOrder: 20,
        order: 0,
      },
      {
        key: 'project:agents-md',
        contributorId: 'project',
        contributionId: 'agents-md',
        target: 'system',
        placement: 'stable-prefix',
        cacheScope: 'project',
        fingerprint: 'agents-md-v3',
        contributorOrder: 10,
        order: 0,
      },
      {
        key: 'global:base',
        contributorId: 'global',
        contributionId: 'base',
        target: 'system',
        placement: 'stable-prefix',
        cacheScope: 'global',
        fingerprint: 'base-v2',
        contributorOrder: 0,
        order: 0,
      },
      {
        key: 'volatile:clock',
        contributorId: 'volatile',
        contributionId: 'clock',
        target: 'metadata',
        placement: 'tail',
        cacheScope: 'none',
        fingerprint: 'clock-v1',
        contributorOrder: 30,
        order: 0,
      },
    ];

    const forward = buildCachePlan(contributions);
    const reversed = buildCachePlan([...contributions].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.entries.map((entry) => entry.cacheScope)).toEqual([
      'global',
      'project',
      'turn',
    ]);
    expect(forward.entries.some((entry) => entry.cacheScope === 'none')).toBe(false);
    expect(forward.fingerprint).toMatch(/^cache-v1-/);
    expect(forward.stablePrefixFingerprint).toMatch(/^cache-v1-/);
  });

  it('keeps projected history when a contributor fails and records a warning', async () => {
    const projection = {
      messages: [user('u1', 'request'), assistant('a1', 'answer')],
      warnings: ['Existing projection warning'],
    };
    const failingContributor = {
      id: 'broken-mailbox',
      collect: async () => {
        throw new Error('mailbox unavailable');
      },
    } satisfies ContextContributor;

    const snapshot = await buildModelContextSnapshot(
      projection,
      [failingContributor],
      { requestId: 'request-2', context: undefined },
    );

    expect(snapshot.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ code: 'projection-warning' }),
      expect.objectContaining({
        code: 'contributor-failed',
        contributorId: 'broken-mailbox',
        message: expect.stringContaining('mailbox unavailable'),
      }),
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.cachePlan.entries)).toBe(true);
  });
});

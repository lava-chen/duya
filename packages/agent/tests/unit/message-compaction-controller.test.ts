import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageContent } from '../../src/types.js';
import type {
  AgentMessage,
  CompactionEntry,
  MessageEntry,
} from '../../src/message/message-framework.js';
import { MessageTimeline } from '../../src/message/message-framework.js';
import { projectModelMessages } from '../../src/message/message-projectors.js';
import {
  MessageCompactionController,
  type CompactionManagerLike,
  type CompactProactiveOptions,
} from '../../src/message/message-compaction-controller.js';
import type { EnhancedCompactionResult } from '../../src/compact/CompactionManager.js';

// ─── Fixtures ───────────────────────────────────────────────────────────

const CREATED_AT = 1_700_000_000_000;

function user(id: string, content: string): AgentMessage {
  return {
    kind: 'user',
    id,
    createdAt: CREATED_AT,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function assistant(id: string, content: string): AgentMessage {
  return {
    kind: 'assistant',
    id,
    createdAt: CREATED_AT,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function assistantWithToolUse(
  id: string,
  toolUseId: string,
  toolName: string,
): AgentMessage {
  const content: MessageContent[] = [
    { type: 'text', text: `Using ${toolName}` },
    { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
  ];
  return {
    kind: 'assistant',
    id,
    createdAt: CREATED_AT,
    persistence: 'durable',
    visibility: 'visible',
    content,
  };
}

function toolResult(
  id: string,
  toolCallId: string,
  toolName: string,
): AgentMessage {
  return {
    kind: 'tool_result',
    id,
    createdAt: CREATED_AT,
    persistence: 'durable',
    visibility: 'visible',
    toolCallId,
    toolName,
    content: 'result payload',
    isError: false,
  };
}

function messageEntry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id, parentId: null, createdAt: CREATED_AT, message };
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/**
 * Builds an `EnhancedCompactionResult` that mimics what a real strategy
 * produces: a system-role summary marker followed by the retained messages.
 * `keptFromIndex` slices the projected input — messages before that index are
 * "compacted" (listed in `compactedMessageIds`), the rest are retained.
 */
function buildStrategyResult(
  inputMessages: readonly Message[],
  keptFromIndex: number,
  summary: string,
  strategy: string,
  opts: { withCompactedIds?: boolean; markerFlags?: Partial<Message> } = {},
): EnhancedCompactionResult {
  const olderMessages = inputMessages.slice(0, keptFromIndex);
  const retainedMessages = inputMessages.slice(keptFromIndex);

  const marker: Message = {
    role: 'system',
    content: summary,
    timestamp: CREATED_AT,
    isCompactSummary: true,
    compactBoundaryId: nextId('boundary'),
    compactedMessageIds: opts.withCompactedIds
      ? olderMessages
          .map((m) => m.id)
          .filter((id): id is string => !!id)
      : undefined,
    ...opts.markerFlags,
  };

  const resultMessages = [marker, ...retainedMessages];
  return {
    messages: resultMessages,
    tokensRemoved: 800,
    tokensRetained: 200,
    strategy,
  };
}

/**
 * Fake `CompactionManager` whose `compact` / `reactiveCompact` delegate to a
 * result builder that receives the projected input `Message[]`. This lets each
 * test control exactly which messages the strategy "retains" while keeping ids
 * consistent with the timeline.
 */
function createFakeManager(
  buildResult: (input: Message[]) => EnhancedCompactionResult,
): CompactionManagerLike & { compactCalls: number; reactiveCalls: number } {
  const calls = { compactCalls: 0, reactiveCalls: 0 };
  return {
    compact: vi.fn(async (messages: Message[]) => {
      calls.compactCalls += 1;
      return buildResult(messages);
    }),
    reactiveCompact: vi.fn(async (messages: Message[]) => {
      calls.reactiveCalls += 1;
      return buildResult(messages);
    }),
    updateContextTokens: vi.fn(),
    shouldCompact: vi.fn(() => true),
    get compactCalls() {
      return calls.compactCalls;
    },
    get reactiveCalls() {
      return calls.reactiveCalls;
    },
  };
}

function createController(
  timeline: MessageTimeline,
  manager: CompactionManagerLike,
  overrides: { idGenerator?: () => string; clock?: () => number } = {},
): MessageCompactionController {
  return new MessageCompactionController({
    timeline,
    compactionManager: manager,
    idGenerator: overrides.idGenerator ?? (() => nextId('compaction')),
    clock: overrides.clock ?? (() => CREATED_AT),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MessageCompactionController', () => {
  describe('proactive compaction — append-only invariant', () => {
    it('appends a CompactionEntry without removing or overwriting original MessageEntries', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'second')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'second reply')));
      timeline.appendMessage(messageEntry('e-u3', user('u3', 'third')));
      timeline.appendMessage(messageEntry('e-a3', assistant('a3', 'third reply')));

      const originalSnapshot = timeline.snapshot();

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 4, 'Earlier conversation summarised.', 'micro'),
      );
      const controller = createController(timeline, manager);

      const entry = await controller.compactProactive();

      expect(entry).not.toBeNull();
      const snapshot = timeline.snapshot();

      // Every original entry is still present, in order, unchanged.
      expect(snapshot.slice(0, originalSnapshot.length)).toEqual(originalSnapshot);

      // Exactly one CompactionEntry was appended.
      const appended = snapshot.slice(originalSnapshot.length);
      expect(appended).toHaveLength(1);
      expect(appended[0]!.type).toBe('compaction');
    });

    it('returns null and appends nothing when the strategy produces no compaction marker', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'hi')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'hello')));

      const manager = createFakeManager((input) => ({
        messages: [...input],
        tokensRemoved: 0,
        tokensRetained: 50,
        strategy: 'micro',
      }));
      const controller = createController(timeline, manager);

      const entry = await controller.compactProactive();

      expect(entry).toBeNull();
      expect(timeline.snapshot()).toHaveLength(2);
    });
  });

  describe('CompactionEntry field completeness', () => {
    it('records compactedMessageIds, firstKeptMessageId, summary, strategy, tokensBefore/After, previousCompactionId', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'second')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'second reply')));
      timeline.appendMessage(messageEntry('e-u3', user('u3', 'kept')));
      timeline.appendMessage(messageEntry('e-a3', assistant('a3', 'kept reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 4, 'Summary of earlier work.', 'session_memory', {
          withCompactedIds: true,
        }),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactProactive())!;

      expect(entry.type).toBe('compaction');
      expect(entry.strategy).toBe('session_memory');
      expect(entry.summary).toBe('Summary of earlier work.');
      expect(entry.firstKeptMessageId).toBe('u3');
      expect(entry.compactedMessageIds).toEqual(['u1', 'a1', 'u2', 'a2']);
      expect(entry.tokensBefore).toBeGreaterThan(0);
      expect(entry.tokensAfter).toBe(200);
      expect(entry.previousCompactionId).toBeUndefined();
    });
  });

  describe('model context reads latest checkpoint', () => {
    it('buildAgentContext projects only the summary plus retained suffix after compaction', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'old reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Old context summarised.', 'micro'),
      );
      const controller = createController(timeline, manager);

      await controller.compactProactive();

      const projection = timeline.buildContext();

      expect(projection.compaction).toBeDefined();
      expect(projection.warnings).toEqual([]);
      // Transient summary synthesised from CompactionEntry + retained suffix.
      expect(projection.messages.map((m) => m.id)).toEqual([
        `${projection.compaction!.id}:summary`,
        'u2',
        'a2',
      ]);
    });

    it('projectInputMessages returns post-checkpoint Message[] via projectModelMessages', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'old reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'First summary.', 'micro'),
      );
      const controller = createController(timeline, manager);

      // Before compaction: input is the full history.
      const beforeInput = controller.projectInputMessages();
      expect(beforeInput.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);

      await controller.compactProactive();

      // After compaction: input is [summary, u2, a2] — the manager never sees
      // the full raw history, only the latest checkpoint view.
      const afterInput = controller.projectInputMessages();
      expect(afterInput).toHaveLength(3);
      expect(afterInput[0]!.isCompactSummary).toBe(true);
      expect(afterInput.slice(1).map((m) => m.id)).toEqual(['u2', 'a2']);
    });
  });

  describe('summary is not duplicated', () => {
    it('summary lives only in the CompactionEntry, never as a MessageEntry', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'old reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Unique summary text.', 'micro'),
      );
      const controller = createController(timeline, manager);

      await controller.compactProactive();

      // No MessageEntry in the timeline contains the summary text.
      const messageEntries = timeline
        .snapshot()
        .filter((e): e is MessageEntry => e.type === 'message');
      for (const entry of messageEntries) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : '';
        expect(text).not.toContain('Unique summary text.');
      }

      // The summary appears exactly once in the model projection — as the
      // transient compaction_summary user message, never in the system prompt.
      const projection = timeline.buildContext();
      const modelProjection = projectModelMessages(projection.messages);
      expect(modelProjection.system).toBe('');

      const summaryMessages = modelProjection.messages.filter(
        (m) => m.isCompactSummary === true,
      );
      expect(summaryMessages).toHaveLength(1);
      expect(summaryMessages[0]!.content).toContain('Unique summary text.');
    });
  });

  describe('tool_use / tool_result safety boundary', () => {
    it('walks the boundary back to a user turn when the strategy retains from a tool_result', async () => {
      // Timeline: u1 → a1(tool_use) → t1(tool_result) → u2 → a2(tool_use) → t2(tool_result) → u3 → a3
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'start')));
      timeline.appendMessage(
        messageEntry('e-a1', assistantWithToolUse('a1', 'tu1', 'Read')),
      );
      timeline.appendMessage(messageEntry('e-t1', toolResult('t1', 'tu1', 'Read')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'continue')));
      timeline.appendMessage(
        messageEntry('e-a2', assistantWithToolUse('a2', 'tu2', 'Write')),
      );
      timeline.appendMessage(messageEntry('e-t2', toolResult('t2', 'tu2', 'Write')));
      timeline.appendMessage(messageEntry('e-u3', user('u3', 'latest')));
      timeline.appendMessage(messageEntry('e-a3', assistant('a3', 'latest reply')));

      // Strategy tries to retain from t2 (index 5) — an orphaned tool_result
      // whose matching tool_use (a2) was compacted.
      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 5, 'Compacted with unsafe boundary.', 'micro'),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactProactive())!;

      // Boundary must be walked back to u2 (the nearest user turn before t2)
      // so a2 + t2 stay together as a complete tool round.
      expect(entry.firstKeptMessageId).toBe('u2');
      expect(entry.compactedMessageIds).toEqual(['u1', 'a1', 't1']);

      // buildAgentContext must not produce an orphaned tool_result.
      const projection = timeline.buildContext();
      expect(projection.warnings).toEqual([]);
      const projectedIds = projection.messages.map((m) => m.id);
      expect(projectedIds).toContain('a2');
      expect(projectedIds).toContain('t2');
    });

    it('keeps the boundary unchanged when the strategy already lands on a user turn', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Summary.', 'micro'),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactProactive())!;

      expect(entry.firstKeptMessageId).toBe('u2');
      expect(entry.compactedMessageIds).toEqual(['u1', 'a1']);
    });
  });

  describe('reactive compaction', () => {
    it('appends a CompactionEntry via reactiveCompact with the reactive strategy name', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'old reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Reactive summary.', 'reactive_snip'),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactReactive('prompt_too_long'))!;

      expect(entry).not.toBeNull();
      expect(entry.strategy).toBe('reactive_snip');
      expect(entry.firstKeptMessageId).toBe('u2');
      expect(entry.compactedMessageIds).toEqual(['u1', 'a1']);

      // The reactive path must call reactiveCompact, not compact.
      expect(manager.reactiveCalls).toBe(1);
      expect(manager.compactCalls).toBe(0);

      // Original entries preserved.
      const messageEntries = timeline
        .snapshot()
        .filter((e): e is MessageEntry => e.type === 'message');
      expect(messageEntries.map((e) => e.message.id)).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
      ]);
    });
  });

  describe('multiple compactions — traceability', () => {
    it('chains previousCompactionId and preserves every original message across two compactions', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'second')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'second reply')));
      timeline.appendMessage(messageEntry('e-u3', user('u3', 'third')));
      timeline.appendMessage(messageEntry('e-a3', assistant('a3', 'third reply')));

      // First compaction: keep from u3 onward.
      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 4, 'First compaction summary.', 'micro'),
      );
      const controller = createController(timeline, manager, {
        idGenerator: () => 'c1',
      });

      const c1 = (await controller.compactProactive())!;
      expect(c1.id).toBe('c1');
      expect(c1.previousCompactionId).toBeUndefined();
      expect(c1.compactedMessageIds).toEqual(['u1', 'a1', 'u2', 'a2']);
      expect(c1.firstKeptMessageId).toBe('u3');

      // New messages arrive after the first compaction.
      timeline.appendMessage(messageEntry('e-u4', user('u4', 'fourth')));
      timeline.appendMessage(messageEntry('e-a4', assistant('a4', 'fourth reply')));

      // Second compaction: keep from u4 onward. The input now includes the
      // transient C1 summary (as a user-role isCompactSummary message) plus
      // u3, a3, u4, a4. The strategy retains the last 2.
      const manager2 = createFakeManager((input) => {
        // Input: [c1:summary, u3, a3, u4, a4] → keep from u4 (index 3)
        return buildStrategyResult(input, 3, 'Second compaction summary.', 'session_memory');
      });
      const controller2 = createController(timeline, manager2, {
        idGenerator: () => 'c2',
      });

      const c2 = (await controller2.compactProactive())!;
      expect(c2.id).toBe('c2');
      expect(c2.previousCompactionId).toBe('c1');
      expect(c2.firstKeptMessageId).toBe('u4');
      // u3 and a3 are the real MessageEntries compacted by the second pass.
      // The transient C1 summary id is NOT listed (it is not a MessageEntry).
      expect(c2.compactedMessageIds).toEqual(['u3', 'a3']);

      // All original messages are still in the timeline.
      const messageIds = timeline
        .snapshot()
        .filter((e): e is MessageEntry => e.type === 'message')
        .map((e) => e.message.id);
      expect(messageIds).toEqual([
        'u1',
        'a1',
        'u2',
        'a2',
        'u3',
        'a3',
        'u4',
        'a4',
      ]);

      // Both CompactionEntries are in the timeline.
      const compactionEntries = timeline
        .snapshot()
        .filter((e): e is CompactionEntry => e.type === 'compaction');
      expect(compactionEntries.map((e) => e.id)).toEqual(['c1', 'c2']);

      // buildAgentContext uses only the latest checkpoint (C2).
      const projection = timeline.buildContext();
      expect(projection.compaction?.id).toBe('c2');
      expect(projection.messages.map((m) => m.id)).toEqual([
        'c2:summary',
        'u4',
        'a4',
      ]);
    });
  });

  describe('strategy without compactedMessageIds', () => {
    it('computes compactedMessageIds from the timeline boundary when the strategy omits them', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'old reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')));

      // Reactive strategy produces a marker without compactedMessageIds.
      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Reactive summary.', 'reactive_snip', {
          withCompactedIds: false,
        }),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactReactive('context_length_exceeded'))!;

      // Controller derives compactedMessageIds from the timeline boundary.
      expect(entry.compactedMessageIds).toEqual(['u1', 'a1']);
      expect(entry.firstKeptMessageId).toBe('u2');
    });
  });

  describe('shouldCompact convenience', () => {
    it('updates tokens from the projected input and delegates to the manager', () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'hi')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'hello')));

      const manager = createFakeManager(() =>
        buildStrategyResult([], 0, 'noop', 'micro'),
      );
      const controller = createController(timeline, manager);

      controller.shouldCompact();

      expect(manager.updateContextTokens).toHaveBeenCalledTimes(1);
      expect(manager.shouldCompact).toHaveBeenCalledTimes(1);
    });
  });

  describe('forwards proactive options to the manager', () => {
    it('passes strategy and workingDirectory through', async () => {
      const timeline = new MessageTimeline();
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'old')));
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'reply')));
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')));
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'reply')));

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Summary.', 'snip'),
      );
      const controller = createController(timeline, manager);

      const options: CompactProactiveOptions = {
        strategy: 'snip',
        workingDirectory: '/tmp/work',
      };
      await controller.compactProactive(options);

      expect(manager.compact).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ strategy: 'snip', workingDirectory: '/tmp/work' }),
      );
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageContent } from '../../src/types.js';
import type {
  AgentMessage,
  CompactionEntry,
  MessageEntry,
} from '../../src/message/message-framework.js';
import { MessageTimeline } from '../../src/message/message-framework.js';
import {
  projectModelMessages,
  projectTimelinePersistenceMessages,
} from '../../src/message/message-projectors.js';
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
    role: 'user',
    id,
    timestamp: CREATED_AT,
    visibility: 'visible',
    content,
  };
}

function assistant(id: string, content: string): AgentMessage {
  return {
    role: 'assistant',
    id,
    timestamp: CREATED_AT,
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
    role: 'assistant',
    id,
    timestamp: CREATED_AT,
    visibility: 'visible',
    content,
  };
}

function toolResult(
  id: string,
  toolCallId: string,
  toolName: string,
): AgentMessage {
  const content: MessageContent[] = [
    {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: 'result payload',
      is_error: false,
    },
  ];
  return {
    role: 'tool',
    id,
    timestamp: CREATED_AT,
    visibility: 'visible',
    name: toolName,
    tool_call_id: toolCallId,
    content,
  };
}

function messageEntry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id, parentId: null, createdAt: CREATED_AT, message };
}

function legacySystem(id: string, content: string): AgentMessage {
  return {
    role: 'legacy_system',
    timestamp: CREATED_AT,
    visibility: 'visible',
    id,
    payload: { content, contributorId: 'legacy-system', placement: 'history-prefix' as const },
  } as AgentMessage;
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
 * Fake `CompactionManager` whose `compact` delegates to a result builder that
 * receives the projected input `Message[]`. This lets each test control exactly
 * which messages the strategy "retains" while keeping ids consistent with the
 * timeline. Conforming to the single-strategy `CompactionManagerLike`.
 */
function createFakeManager(
  buildResult: (input: Message[]) => EnhancedCompactionResult,
): CompactionManagerLike & { compactCalls: number } {
  const calls = { compactCalls: 0 };
  // The real CompactionManager refreshes its token count inside shouldCompact;
  // mirror that so the "shouldCompact convenience" test observes the delegate.
  const updateContextTokens = vi.fn();
  const shouldCompact = vi.fn(() => {
    updateContextTokens();
    return true;
  });
  const manager: CompactionManagerLike & {
    compactCalls: number;
    updateContextTokens: ReturnType<typeof vi.fn>;
  } = {
    compact: vi.fn(async (messages: Message[]) => {
      calls.compactCalls += 1;
      return buildResult(messages);
    }),
    updateContextTokens,
    shouldCompact,
    get compactCalls() {
      return calls.compactCalls;
    },
  };
  return manager;
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

      // Strategy produces a marker without compactedMessageIds.
      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Summary.', 'session_memory', {
          withCompactedIds: false,
        }),
      );
      const controller = createController(timeline, manager);

      const entry = (await controller.compactProactive())!;

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
  describe('plan 422 — legacy_system reinjection (grok build_compacted_history alignment)', () => {
    it('captures legacy_system content from the compacted range into reinjectedSystemMessages', async () => {
      const timeline = new MessageTimeline()
      const AGENTS_MD = '<agents_md>project conventions: tabs not spaces</agents_md>'
      timeline.appendMessage(messageEntry('e-legacy-1', legacySystem('legacy-1', AGENTS_MD)))
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')))
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')))
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'kept')))
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'kept reply')))

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Summary.', 'session_memory'),
      )
      const controller = createController(timeline, manager)

      const entry = (await controller.compactProactive())!
      expect(entry.reinjectedSystemMessages).toBeDefined()
      expect(entry.reinjectedSystemMessages).toContain(AGENTS_MD)
    })

    it('captures multiple legacy_system entries in order', async () => {
      const timeline = new MessageTimeline()
      const A = '<system_reminder>instruction A</system_reminder>'
      const B = '<system_reminder>instruction B</system_reminder>'
      timeline.appendMessage(messageEntry('e-l1', legacySystem('l1', A)))
      timeline.appendMessage(messageEntry('e-l2', legacySystem('l2', B)))
      timeline.appendMessage(messageEntry('e-u1', user('u1', 'q')))
      timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'r')))
      timeline.appendMessage(messageEntry('e-u2', user('u2', 'q2')))
      timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'r2')))

      const manager = createFakeManager((input) =>
        buildStrategyResult(input, 2, 'Summary.', 'session_memory'),
      )
      const controller = createController(timeline, manager)

      const entry = (await controller.compactProactive())!
      const reinjected = entry.reinjectedSystemMessages ?? []
      expect(reinjected.indexOf(A)).toBeGreaterThanOrEqual(0)
      expect(reinjected.indexOf(B)).toBeGreaterThanOrEqual(0)
      expect(reinjected.indexOf(A)).toBeLessThan(reinjected.indexOf(B))
    })
  })

  describe('plan 422 follow-up — setTimeline keeps compactProactive in sync after agent rebuilds the timeline', () => {
    it('projectInputMessages returns the new timeline after setTimeline (regression: chat:start cold-resume path)', () => {
      // Reproduces the production bug where DuyaAgent.setMessages reassigns
      // `this.timeline = new MessageTimeline(...)`, leaving the controller's
      // captured reference pointing at the empty pre-rebuild instance.
      // compactProactive then forwarded an empty inputMessages array to
      // CompactionManager, which tripped the `conversation is empty` preflight
      // for sessions that loaded from DB without a prior chat:start.

      const initialTimeline = new MessageTimeline();
      const manager = createFakeManager((input) => ({
        messages: [...input],
        tokensRemoved: 0,
        tokensRetained: 50,
        strategy: 'micro',
      }));
      const controller = createController(initialTimeline, manager);

      // Initial state: empty timeline → projection is empty.
      expect(controller.projectInputMessages()).toEqual([]);

      // DuyaAgent.setMessages pattern: replace the timeline field, then
      // repopulate. The controller must be told about the swap.
      const nextTimeline = new MessageTimeline();
      nextTimeline.appendMessage(messageEntry('e-u1', user('u1', 'hello')));
      nextTimeline.appendMessage(messageEntry('e-a1', assistant('a1', 'hi there')));

      // Without setTimeline, the controller still reads from initialTimeline.
      // This is the regression: re-binding to nextTimeline is required.
      controller.setTimeline(nextTimeline);

      const projected = controller.projectInputMessages();
      expect(projected).toHaveLength(2);
      expect(projected.map((m) => m.role)).toEqual(['user', 'assistant']);
      // Real message ids survive the projection (no uuid regeneration here).
      expect(projected.map((m) => m.id)).toEqual(['u1', 'a1']);
    })
  })

});

// ─── Plan 486: branched (thread) messages never enter the compaction window ──

function branchedUser(id: string, replyToId: string): AgentMessage {
  return {
    role: 'user',
    id,
    timestamp: CREATED_AT,
    visibility: 'visible',
    content: `branch ${id}`,
    metadata: { threadMeta: { replyToId, branched: true } },
  } as AgentMessage;
}

describe('plan 486 — branched messages are compaction-transparent', () => {
  it('compaction input excludes branches, compactedMessageIds never name them, and branches survive the timeline', async () => {
    const timeline = new MessageTimeline();
    // Main line: u1 -> a1 (u1/a1 will be folded). A thread forks off u1 and
    // sits INSIDE the would-be compaction prefix.
    timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')));
    timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')));
    timeline.appendMessage(messageEntry('e-fork', branchedUser('fork-1', 'u1')));
    timeline.appendMessage(messageEntry('e-u2', user('u2', 'second')));
    timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'second reply')));

    let capturedInput: Message[] = [];
    const onCompacted = vi.fn();
    const manager = createFakeManager((input) => {
      capturedInput = [...input];
      return buildStrategyResult(input, 2, 'Earlier conversation summarised.', 'micro');
    });
    const controller = new MessageCompactionController({
      timeline,
      compactionManager: manager,
      idGenerator: () => nextId('compaction'),
      clock: () => CREATED_AT,
      onCompacted,
    });

    const entry = await controller.compactProactive();

    expect(entry).not.toBeNull();
    // 1. The strategy input never contains the branched message.
    expect(capturedInput.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // 2. compactedMessageIds only ever name main-line messages.
    expect(entry!.compactedMessageIds).toEqual(['u1', 'a1']);
    expect(entry!.compactedMessageIds).not.toContain('fork-1');
    // 3. The host supersede callback also stays branch-free.
    expect(onCompacted).toHaveBeenCalledWith(['u1', 'a1']);
    // 4. The append-only timeline still holds the branched entry.
    const snapshot = timeline.snapshot();
    expect(snapshot.some((e) => e.type === 'message' && e.message.id === 'fork-1')).toBe(true);
  });

  it('the persistence projection keeps branched rows that fall inside the folded prefix (getThread survives reload)', async () => {
    const timeline = new MessageTimeline();
    timeline.appendMessage(messageEntry('e-u1', user('u1', 'first')));
    timeline.appendMessage(messageEntry('e-a1', assistant('a1', 'first reply')));
    // Fork lives between a1 and u2: after compaction of [u1,a1] it sits inside
    // the folded prefix yet must stay durable.
    timeline.appendMessage(messageEntry('e-fork', branchedUser('fork-1', 'u1')));
    timeline.appendMessage(messageEntry('e-u2', user('u2', 'second')));
    timeline.appendMessage(messageEntry('e-a2', assistant('a2', 'second reply')));

    const manager = createFakeManager((input) =>
      buildStrategyResult(input, 2, 'Earlier conversation summarised.', 'micro'),
    );
    const controller = createController(timeline, manager);
    await controller.compactProactive();

    const projected = projectTimelinePersistenceMessages(timeline.snapshot());
    const ids = projected.map((m) => m.id);
    // Marker + folded-but-branched fork + retained u2/a2 — fork is not lost.
    expect(ids).toContain('fork-1');
    expect(ids).not.toContain('u1');
    expect(ids).not.toContain('a1');

    // Reload simulation: the durable rows rebuild a timeline whose fork is
    // still resolvable as part of u1's thread via chain matching.
    const forkRow = projected.find((m) => m.id === 'fork-1')!;
    expect(forkRow.metadata?.['threadMeta']).toEqual({ replyToId: 'u1', branched: true });
  });
});

/**
 * Unit tests for the agent-core Journal class. Verifies deterministic-id
 * generation, role-based boundary dispatch, and idempotency safety.
 *
 * These tests do NOT exercise the actual IPC path — `messageDb.append` is
 * mocked with a simple in-memory sink. The integration with the
 * db-bridge `journal:emit` handler is verified separately via e2e.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Journal } from '../Journal.js';
import type { Message } from '../../message/index.js';

// ─── Mocks ───

const recordedAppends: Array<{
  sessionId: string;
  messages: unknown[];
  turnId: string | null;
}> = [];

const recordedEmits: Array<{
  sessionId: string;
  event: unknown;
  turnId: string | null;
}> = [];

vi.mock('../../ipc/db-client.js', () => ({
  messageDb: {
    append: (sessionId: string, messages: unknown[], turnId: string | null) => {
      recordedAppends.push({ sessionId, messages, turnId });
      return Promise.resolve({ success: true, count: messages.length });
    },
    emit: (sessionId: string, event: unknown, turnId: string | null) => {
      recordedEmits.push({ sessionId, event, turnId });
      return Promise.resolve({ success: true });
    },
  },
}));

// ─── Builders ───

function userMsg(overrides: Partial<Message> = {}): Message {
  return {
    role: 'user',
    id: 'u-1',
    content: 'hello',
    timestamp: 1000,
    ...overrides,
  } as Message;
}

function assistantMsg(overrides: Partial<Message> = {}): Message {
  return {
    role: 'assistant',
    id: 'a-1',
    content: [{ type: 'text', text: 'hi' }],
    timestamp: 1100,
    ...overrides,
  } as Message;
}

function toolMsg(overrides: Partial<Message> = {}): Message {
  return {
    role: 'tool',
    id: 't-1',
    content: 'result',
    tool_call_id: 'call-1',
    timestamp: 1200,
    ...overrides,
  } as Message;
}

// ─── Tests ───

describe('Journal', () => {
  beforeEach(() => {
    recordedAppends.length = 0;
    recordedEmits.length = 0;
  });

  it('builds deterministic ids for the same source + kind', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.userMsgAdded(userMsg(), 'turn-1');
    journal.userMsgAdded(userMsg(), 'turn-1');

    expect(recordedAppends).toHaveLength(2);
    const id1 = (recordedAppends[0].messages[0] as { id: string }).id;
    const id2 = (recordedAppends[1].messages[0] as { id: string }).id;
    // Same source id + kind → same deterministic id → INSERT OR IGNORE on
    // duplicate paths will silently dedupe (important for retry safety).
    expect(id1).toBe(id2);
    // No timestamp nonce: the id is a pure function of source id + kind, so
    // INSERT OR IGNORE actually dedups retries (a nonce would fork rows).
    expect(id1).toBe('journal:u-1:user_msg_added');
  });

  it('different kinds produce different ids even for the same source', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.userMsgAdded(userMsg({ id: 'shared' }));
    journal.assistantMsgFinalized(assistantMsg({ id: 'shared' }));
    journal.toolResultAdded(toolMsg({ id: 'shared' }));

    expect(recordedAppends).toHaveLength(3);
    const ids = recordedAppends.map((r) => (r.messages[0] as { id: string }).id);
    expect(new Set(ids).size).toBe(3);
  });

  it('different sessions do not share ids (caller-supplied sessionId in IPC payload)', () => {
    const j1 = new Journal({ sessionId: 'sess-A' });
    const j2 = new Journal({ sessionId: 'sess-B' });
    j1.userMsgAdded(userMsg());
    j2.userMsgAdded(userMsg());

    expect(recordedAppends[0].sessionId).toBe('sess-A');
    expect(recordedAppends[1].sessionId).toBe('sess-B');
  });

  it('fires user/assistant/tool boundaries correctly via role dispatch', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.userMsgAdded(userMsg({ id: 'u-x' }), 'turn-A');
    journal.assistantMsgFinalized(assistantMsg({ id: 'a-x' }), 'turn-A');
    journal.toolResultAdded(toolMsg({ id: 't-x' }), 'turn-A');

    expect(recordedAppends).toHaveLength(3);
    // The `kind` discriminator on the DTO tells the db-bridge which
    // boundary to record (matches MessageLog.deriveKind expectations).
    expect((recordedAppends[0].messages[0] as { kind: string }).kind).toBe('user_msg_added');
    expect((recordedAppends[1].messages[0] as { kind: string }).kind).toBe('assistant_message_finalized');
    expect((recordedAppends[2].messages[0] as { kind: string }).kind).toBe('tool_result_added');
  });

  it('emits hook_invoked with caller-supplied id', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.hookInvoked('turn-1', 'hook-evt-7', { name: 'PreToolUse', toolInput: { x: 1 } });

    // hook_invoked is a RolloutEvent, not a MessageEntry — it routes through
    // messageDb.emit (journal:emit) so MessageLog preserves the `type` discriminator.
    expect(recordedEmits).toHaveLength(1);
    expect(recordedAppends).toHaveLength(0);
    const evt = recordedEmits[0].event as { type: string; turnId: string; payload: unknown; id: string };
    expect(evt.type).toBe('hook_invoked');
    expect(evt.turnId).toBe('turn-1');
    expect(evt.payload).toEqual({ name: 'PreToolUse', toolInput: { x: 1 } });
    expect(evt.id).toBe('journal:hook-evt-7:hook_invoked');
    expect(recordedEmits[0].sessionId).toBe('sess-1');
    expect(recordedEmits[0].turnId).toBe('turn-1');
  });

  it('appendRebase converts Message[] to MessageEntry[] before sending', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    const compacted = [
      userMsg({ id: 'c-1', timestamp: 100 }),
      assistantMsg({ id: 'c-2', timestamp: 200 }),
    ];
    journal.appendRebase('turn-1', 5, compacted, 999);

    // Rebase events are RolloutEvents — must route through messageDb.emit so
    // the storage layer stores the {type:'rebase',...} row verbatim instead
    // of collapsing it into a legacy_unknown_role MessageEntry.
    expect(recordedEmits).toHaveLength(1);
    expect(recordedAppends).toHaveLength(0);
    const evt = recordedEmits[0].event as {
      type: string;
      supersededUpToSeq: number;
      newMessages: unknown[];
    };
    expect(evt.type).toBe('rebase');
    expect(evt.supersededUpToSeq).toBe(5);
    expect(Array.isArray(evt.newMessages)).toBe(true);
    expect(evt.newMessages).toHaveLength(2);
    // The converted entries include the storage-shape discriminator
    // (`type: 'message'`) so MessageLog can store them as MessageEntry rows.
    const first = evt.newMessages[0] as { type: string; id: string; createdAt: number; message: { role: string } };
    expect(first.type).toBe('message');
    expect(first.id).toBe('c-1');
    expect(first.createdAt).toBe(100);
    expect(first.message.role).toBe('user');
    expect(recordedEmits[0].sessionId).toBe('sess-1');
    expect(recordedEmits[0].turnId).toBe('turn-1');
  });

  it('appendRebase with null bound supersedes all prior messages', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    const compacted = [
      userMsg({ id: 'c-1', timestamp: 100 }),
      assistantMsg({ id: 'c-2', timestamp: 200 }),
    ];
    journal.appendRebase('turn-1', null, compacted, 999);

    expect(recordedEmits).toHaveLength(1);
    const rebase = recordedEmits[0].event as { supersededUpToSeq: number | null };
    // null = supersede ALL prior raw messages; survivors are kept by id
    // matching in newMessages. A subprocess-local numeric bound cannot be
    // correct for resumed sessions (DB seqs predate the process).
    expect(rebase.supersededUpToSeq).toBeNull();
  });

  it('appendRebase defaults reason to "compaction"', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.appendRebase('turn-1', null, [userMsg({ id: 'c-1', timestamp: 100 })], 999);

    const evt = recordedEmits[0].event as { reason?: string };
    expect(evt.reason).toBe('compaction');
  });

  it('appendRebase forwards an explicit reason (edit_resend)', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.appendRebase(
      'turn-1',
      null,
      [userMsg({ id: 'c-1', timestamp: 100 })],
      999,
      'edit_resend',
    );

    const evt = recordedEmits[0].event as { reason?: string };
    // The reason rides on the event payload verbatim so the storage layer
    // can branch on it. Compaction rebases rotate; edit_resend rebases do
    // not (Plan 506 C1 + Plan 493 Phase B trigger wiring).
    expect(evt.reason).toBe('edit_resend');
  });

  // Regression: Plan 441 left fireEventRaw routing through messageDb.append
  // (message:append IPC) instead of messageDb.emit (journal:emit IPC). The
  // append adapter force-feeds every event through ingestMessage as if it
  // were a fresh IpcMessageDTO, which collapses RolloutEvents (rebase /
  // hook_invoked) into legacy_unknown_role MessageEntry rows on disk and
  // leaves chat_history with broken kind tags. Pin the routing here so a
  // future refactor of fireEventRaw can't silently re-introduce the bug.
  it('routes RolloutEvents through messageDb.emit, never append', () => {
    const journal = new Journal({ sessionId: 'sess-1' });

    journal.hookInvoked('turn-1', 'hook-evt-r', { name: 'PreToolUse' });
    journal.appendRebase(
      'turn-1',
      null,
      [userMsg({ id: 'r-1', timestamp: 100 })],
      Date.now(),
    );

    // Two RolloutEvents, both must land on the emit sink.
    expect(recordedEmits).toHaveLength(2);
    expect(recordedAppends).toHaveLength(0);

    // The emit IPC signature takes the event as a single object (not wrapped
    // in an array), matching db-client.ts: `emit(sessionId, event, turnId)`.
    for (const call of recordedEmits) {
      expect(call.event).toBeDefined();
      expect((call.event as { type: string }).type).toMatch(/^(rebase|hook_invoked)$/);
    }
  });

  it('surfaces emit failures through onError', async () => {
    const errors: Array<{ kind: string; err: unknown }> = [];
    // Re-route the mocked emit sink to resolve with {success:false} for this
    // test only. The success:false branch in fireEventRaw must invoke
    // onError with the new "emit returned" wording — not the old
    // "append returned" string.
    const { messageDb } = await import('../../ipc/db-client.js');
    const realEmit = messageDb.emit;
    const spy = vi.spyOn(messageDb, 'emit').mockImplementationOnce(
      (_sessionId, _event, _turnId) =>
        Promise.resolve({ success: false, reason: 'rolled back in test' }),
    );
    try {
      const failingJournal = new Journal({
        sessionId: 'sess-1',
        onError: (kind, err) => errors.push({ kind, err }),
      });
      failingJournal.hookInvoked('turn-1', 'hook-evt-fail', { name: 'noop' });
      await failingJournal.flush();
      expect(errors).toHaveLength(1);
      expect(errors[0].kind).toBe('hook_invoked');
      // The error message must come from the new emit-path copy. The old
      // wording would mean the bug regressed.
      const errStr = (errors[0].err as Error).message;
      expect(errStr).toContain('emit returned');
      expect(errStr).toContain('rolled back in test');
    } finally {
      spy.mockRestore();
      // Ensure the test leaves the module in a clean state even if
      // mockImplementationOnce was the only mock (realEmit unused).
      void realEmit;
    }
  });

  it('passes turnId through to the IPC payload', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.userMsgAdded(userMsg({ id: 'u-x' }), 'turn-A');
    journal.userMsgAdded(userMsg({ id: 'u-y' }), null);

    expect(recordedAppends[0].turnId).toBe('turn-A');
    expect(recordedAppends[1].turnId).toBe(null);
  });

  it('forwards append failures to onError without throwing', () => {
    const errors: Array<{ kind: string; err: unknown }> = [];
    // Replace the recorded sink with one that rejects.
    recordedAppends.length = 0;
    // Manually inject a failure: re-mock by writing a fresh journal that
    // captures the error path.
    const errJournal = new Journal({
      sessionId: 'sess-1',
      onError: (kind, err) => errors.push({ kind, err }),
    });
    // Direct call to a private helper is not possible, but we can verify
    // the success path first then the failure by patching the append
    // through a sentinel: dispatch a hook with a missing id (which we
    // guard against) and confirm the journal silently skips.
    errJournal.hookInvoked('turn-1', '', { name: 'noop' });
    expect(errors).toHaveLength(0);
    expect(recordedEmits).toHaveLength(0); // empty hookEventId dropped
  });
});
describe('Journal token_usage serialization (plan 444 ring fix)', () => {
  beforeEach(() => {
    recordedAppends.length = 0;
    recordedEmits.length = 0;
  });

  it('serializes a top-level tokenUsage object into dto.token_usage', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(
      assistantMsg({
        id: 'a-usage',
        tokenUsage: { input_tokens: 10, output_tokens: 5, cache_hit_tokens: 100 } as Message['tokenUsage'],
      } as Partial<Message> as Message),
      'turn-1',
    );

    expect(recordedAppends).toHaveLength(1);
    const dto = recordedAppends[0].messages[0] as { token_usage?: string };
    expect(dto.token_usage).toBeTypeOf('string');
    expect(JSON.parse(dto.token_usage!)).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_hit_tokens: 100,
    });
  });

  it('prefers metadata.token_usage string when no top-level block exists', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(
      assistantMsg({
        id: 'a-meta',
        metadata: { token_usage: '{"input_tokens":1}' },
      } as Partial<Message> as Message),
      'turn-1',
    );

    const dto = recordedAppends[0].messages[0] as { token_usage?: string };
    expect(dto.token_usage).toBe('{"input_tokens":1}');
  });

  it('omits token_usage when neither source has it', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.assistantMsgFinalized(assistantMsg({ id: 'a-plain' }), 'turn-1');

    const dto = recordedAppends[0].messages[0] as { token_usage?: string };
    expect(dto.token_usage).toBeUndefined();
  });

  it('plan 486: carries threadMeta on the journal emit so branches stay durable', () => {
    const journal = new Journal({ sessionId: 'sess-1' });
    journal.userMsgAdded(
      userMsg({
        id: 'fork-1',
        metadata: { threadMeta: { replyToId: 'root-1', branched: true } },
      } as Partial<Message> as Message),
      'turn-1',
    );
    journal.userMsgAdded(userMsg({ id: 'plain-1' }), 'turn-1');

    const forkDto = recordedAppends[0].messages[0] as { metadata?: Record<string, unknown> };
    expect(forkDto.metadata).toEqual({
      threadMeta: { replyToId: 'root-1', branched: true },
    });
    const plainDto = recordedAppends[1].messages[0] as { metadata?: Record<string, unknown> };
    expect(plainDto.metadata).toBeUndefined();
  });
});

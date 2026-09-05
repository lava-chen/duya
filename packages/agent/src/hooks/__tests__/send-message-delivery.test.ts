/**
 * SendMessage delivery enforcement hook tests (grok ensureUserReply port,
 * plan 496).
 *
 * Covers the pure predicates and the two hook factories ported from grok-bot
 * 0.18 system-prompt.ts (USER_MESSAGE_REPLY_REMINDER) and turn-runtime.ts
 * (REPLY_NUDGE / CLOSING_SEND_NUDGE):
 * - reply reminder fires once on the first model round of a user-facing run
 * - delivery veto fires while no SendMessage happened since the user turn,
 *   capped at MAX_SEND_MESSAGE_NUDGES per run
 * - closing-send veto fires once when the turn ends on silent tool calls
 *   after an acknowledgement
 * - silenceAllowed / disabled gates never register behavior
 */

import { describe, expect, it } from 'vitest';
import {
  CLOSING_SEND_NUDGE_INJECTION,
  createSendMessageDeliveryHook,
  createSendMessageReplyReminderHook,
  hasRealUserTurn,
  isDeliveryOwed,
  isRealUserMessage,
  MAX_SEND_MESSAGE_NUDGES,
  REPLY_NUDGE_INJECTION,
} from '../send-message-delivery.js';
import { USER_MESSAGE_REPLY_REMINDER } from '../send-message-reminder.js';
import type { Message } from '../../types.js';

function assistantWithTools(...names: string[]): Message {
  return {
    role: 'assistant',
    content: names.map((name) => ({
      type: 'tool_use' as const,
      id: `tu-${Math.random().toString(36).slice(2)}`,
      name,
      input: {},
    })),
    timestamp: Date.now(),
  } as unknown as Message;
}

function assistantWithText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text' as const, text }],
    timestamp: Date.now(),
  } as unknown as Message;
}

function userTurn(text = 'do the thing'): Message {
  return {
    role: 'user',
    content: text,
    timestamp: Date.now(),
  } as unknown as Message;
}

function reminderTurn(): Message {
  return {
    role: 'user',
    content: USER_MESSAGE_REPLY_REMINDER,
    timestamp: Date.now(),
    metadata: { runtimeContext: true, source: 'send_message_reminder' },
  } as unknown as Message;
}

function mailboxTurn(): Message {
  // Runtime-context projection that is NOT a send-message reminder.
  return {
    role: 'user',
    content: 'Background task finished.',
    timestamp: Date.now(),
    metadata: { runtimeContext: true, source: 'mailbox' },
  } as unknown as Message;
}

const enabled = { enabled: true, silenceAllowed: false };

describe('SendMessage delivery predicates', () => {
  it('isRealUserMessage distinguishes real turns from projections', () => {
    expect(isRealUserMessage(userTurn('hi'))).toBe(true);
    expect(isRealUserMessage(userTurn('   '))).toBe(false);
    expect(isRealUserMessage(reminderTurn())).toBe(false);
    expect(isRealUserMessage(mailboxTurn())).toBe(false);
    expect(isRealUserMessage(assistantWithText('text'))).toBe(false);
    expect(isRealUserMessage(null)).toBe(false);
  });

  it('hasRealUserTurn ignores runtime-context-only histories', () => {
    expect(hasRealUserTurn([reminderTurn(), mailboxTurn()])).toBe(false);
    expect(hasRealUserTurn([mailboxTurn(), userTurn('hi')])).toBe(true);
  });

  it('isDeliveryOwed: user turn with no SendMessage since it', () => {
    const messages = [
      userTurn('你好'),
      assistantWithText('你好！有什么可以帮你？'),
    ];
    expect(isDeliveryOwed(messages)).toBe(true);
  });

  it('isDeliveryOwed: satisfied once a SendMessage call happened', () => {
    const messages = [
      userTurn('你好'),
      assistantWithTools('SendMessage'),
      assistantWithText('scratchpad text the user never sees'),
    ];
    expect(isDeliveryOwed(messages)).toBe(false);
  });

  it('isDeliveryOwed: no real user turn means nothing is owed', () => {
    expect(isDeliveryOwed([assistantWithText('orphan text')])).toBe(false);
    expect(isDeliveryOwed([mailboxTurn(), assistantWithText('t')])).toBe(false);
  });
});

describe('SendMessage reply reminder hook (L2)', () => {
  it('injects on the first model round when the tail is the user prompt', () => {
    const hook = createSendMessageReplyReminderHook(enabled);
    const effect = hook.handler({
      event: 'PreTurn',
      turnCount: 1,
      seqIndex: 0,
      messages: [userTurn('hi')],
    });
    expect(effect).toEqual({
      type: 'inject',
      injection: USER_MESSAGE_REPLY_REMINDER,
      source: 'send_message_reminder',
    });
  });

  it('does not fire on later rounds, runtime-context tails, or gated runs', () => {
    const hook = createSendMessageReplyReminderHook(enabled);
    const later = hook.handler({
      event: 'PreTurn',
      turnCount: 2,
      seqIndex: 1,
      messages: [userTurn('hi'), assistantWithText('x'), reminderTurn()],
    });
    expect(later).toBeUndefined();

    const mailboxTail = hook.handler({
      event: 'PreTurn',
      turnCount: 1,
      seqIndex: 0,
      messages: [mailboxTurn()],
    });
    expect(mailboxTail).toBeUndefined();

    const silent = createSendMessageReplyReminderHook({
      enabled: true,
      silenceAllowed: true,
    });
    expect(
      silent.handler({
        event: 'PreTurn',
        turnCount: 1,
        seqIndex: 0,
        messages: [userTurn('hi')],
      }),
    ).toBeUndefined();

    const off = createSendMessageReplyReminderHook({ enabled: false });
    expect(
      off.handler({
        event: 'PreTurn',
        turnCount: 1,
        seqIndex: 0,
        messages: [userTurn('hi')],
      }),
    ).toBeUndefined();
  });
});

describe('SendMessage delivery hook (L4)', () => {
  it('vetoes finalize while delivery is owed, capped at MAX nudges', () => {
    const hook = createSendMessageDeliveryHook(enabled);
    const handler = hook.handler;
    const ctx = (messages: Message[]) => ({
      event: 'PreFinalize' as const,
      turnCount: 2,
      seqIndex: 1,
      messages,
      stopReason: 'end_turn',
    });

    for (let i = 1; i <= MAX_SEND_MESSAGE_NUDGES; i++) {
      const effect = handler(ctx([userTurn('hi'), assistantWithText('x')]));
      expect(effect).toMatchObject({ type: 'block_finalize' });
      expect((effect as { injection: string }).injection).toBe(
        REPLY_NUDGE_INJECTION,
      );
    }
    // After the cap the hook gives up (fail-open) instead of looping forever.
    expect(handler(ctx([userTurn('hi'), assistantWithText('x')]))).toBeUndefined();
  });

  it('stops vetoing once a SendMessage call exists in the turn', () => {
    const hook = createSendMessageDeliveryHook(enabled);
    const messages = [
      userTurn('hi'),
      assistantWithText('scratchpad'),
      assistantWithTools('SendMessage'),
    ];
    expect(
      hook.handler({
        event: 'PreFinalize',
        turnCount: 2,
        seqIndex: 1,
        messages,
        stopReason: 'end_turn',
      }),
    ).toBeUndefined();
  });

  it('fires the closing-send nudge once when ack is followed by silent tool calls', () => {
    const hook = createSendMessageDeliveryHook(enabled);
    const messages = [
      userTurn('find the file'),
      assistantWithTools('SendMessage'),
      assistantWithTools('Bash', 'Grep'),
    ];
    const effect = hook.handler({
      event: 'PreFinalize',
      turnCount: 3,
      seqIndex: 2,
      messages,
      stopReason: 'end_turn',
    });
    expect(effect).toMatchObject({ type: 'block_finalize' });
    expect((effect as { injection: string }).injection).toBe(
      CLOSING_SEND_NUDGE_INJECTION,
    );

    // Second natural stop on the same shape: already fired once — no repeat.
    expect(
      hook.handler({
        event: 'PreFinalize',
        turnCount: 4,
        seqIndex: 3,
        messages,
        stopReason: 'end_turn',
      }),
    ).toBeUndefined();
  });

  it('never fires on silence-allowed runs', () => {
    const hook = createSendMessageDeliveryHook({
      enabled: true,
      silenceAllowed: true,
    });
    expect(
      hook.handler({
        event: 'PreFinalize',
        turnCount: 1,
        seqIndex: 0,
        messages: [userTurn('hi'), assistantWithText('x')],
        stopReason: 'end_turn',
      }),
    ).toBeUndefined();
  });
});

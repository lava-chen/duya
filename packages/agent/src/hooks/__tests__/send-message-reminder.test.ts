/**
 * SendMessage reminder hook tests (grok SendMessageReminderMiddleware port).
 *
 * Covers the pure predicates and the PreTurn hook decision table ported from
 * grok-bot 0.18 send-message-reminder-middleware.ts:
 * - silence reminder after > threshold quiet tool calls
 * - early-result reminder once per silent streak after a sent message
 * - no double-fire when the last message is already a reminder
 * - streak reset on SendMessage calls / real user turns
 */

import { describe, expect, it } from 'vitest';
import {
  createSendMessageReminderHook,
  countNonSendMessageToolCalls,
  countToolCallsSinceLastSendMessage,
  EARLY_RESULT_REMINDER_MESSAGE,
  hasReminderFiredThisSilentStreak,
  hasSendMessageCall,
  hasSendMessageSinceRealTurnStart,
  isSendMessageReminderMessage,
  SEND_MESSAGE_REMINDER_MESSAGE,
} from '../send-message-reminder.js';
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

function reminderTurn(kind: 'silence' | 'early'): Message {
  // Shape mirrors projectRuntimeContextToProviderMessage: role user, string
  // content, metadata.source identifying the reminder family.
  return {
    role: 'user',
    content: kind === 'silence' ? SEND_MESSAGE_REMINDER_MESSAGE : EARLY_RESULT_REMINDER_MESSAGE,
    timestamp: Date.now(),
    metadata: { runtimeContext: true, source: 'send_message_reminder' },
  } as unknown as Message;
}

function toolResultTurn(): Message {
  return {
    role: 'tool',
    content: [{ type: 'tool_result' as const, tool_use_id: 'tu-x', content: 'ok' }],
    timestamp: Date.now(),
  } as unknown as Message;
}

describe('SendMessage reminder predicates', () => {
  it('detects SendMessage vs other tool calls', () => {
    const m = assistantWithTools('Read', 'SendMessage', 'Bash');
    expect(hasSendMessageCall(m)).toBe(true);
    expect(countNonSendMessageToolCalls(m)).toBe(2);
    expect(countNonSendMessageToolCalls(userTurn())).toBe(0);
  });

  it('counts tool calls since the last SendMessage, stopping at user turns', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('Read', 'Bash'),
      toolResultTurn(),
      assistantWithTools('Write'),
      toolResultTurn(),
    ];
    expect(countToolCallsSinceLastSendMessage(messages)).toBe(3);

    const withSend = [
      ...messages,
      assistantWithTools('SendMessage'),
      toolResultTurn(),
      assistantWithTools('Read'),
    ];
    expect(countToolCallsSinceLastSendMessage(withSend)).toBe(1);
  });

  it('detects a SendMessage since real turn start, skipping reminders', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('Read'),
      toolResultTurn(),
      assistantWithTools('SendMessage'),
      toolResultTurn(),
      reminderTurn('early'),
      assistantWithTools('Bash'),
    ];
    expect(hasSendMessageSinceRealTurnStart(messages)).toBe(true);
    expect(hasSendMessageSinceRealTurnStart([userTurn('go'), assistantWithTools('Read')])).toBe(false);
  });

  it('detects a fired reminder within the current silent streak', () => {
    const fired = [userTurn('go'), reminderTurn('early'), assistantWithTools('Read')];
    expect(hasReminderFiredThisSilentStreak(fired)).toBe(true);
    // A SendMessage call resets the streak.
    const afterSend = [userTurn('go'), reminderTurn('early'), assistantWithTools('SendMessage')];
    expect(hasReminderFiredThisSilentStreak(afterSend)).toBe(false);
    // A real user turn resets the streak.
    const afterUser = [userTurn('go'), reminderTurn('early'), userTurn('again')];
    expect(hasReminderFiredThisSilentStreak(afterUser)).toBe(false);
  });

  it('recognizes reminders by metadata or content fallback', () => {
    expect(isSendMessageReminderMessage(reminderTurn('silence'))).toBe(true);
    expect(
      isSendMessageReminderMessage({ role: 'user', content: `x ${SEND_MESSAGE_REMINDER_MESSAGE}` }),
    ).toBe(true);
    expect(isSendMessageReminderMessage(userTurn('hello'))).toBe(false);
    expect(isSendMessageReminderMessage(null)).toBe(false);
  });

  it('counts post_to_room as a delivery (Plan 501 L2: group voice)', () => {
    expect(hasSendMessageCall(assistantWithTools('post_to_room'))).toBe(true);
    expect(countNonSendMessageToolCalls(assistantWithTools('post_to_room', 'Read'))).toBe(1);

    // A room turn that already posted does not owe a delivery.
    const roomTurn = [
      userTurn('room prompt'),
      assistantWithTools('post_to_room'),
      toolResultTurn(),
      assistantWithTools('Read'),
    ];
    expect(hasSendMessageSinceRealTurnStart(roomTurn)).toBe(true);
    expect(countToolCallsSinceLastSendMessage(roomTurn)).toBe(1);
  });
});

describe('createSendMessageReminderHook', () => {
  const hook = createSendMessageReminderHook({ enabled: true });

  function run(messages: Message[]) {
    return hook.handler({
      event: 'PreTurn',
      sessionId: 's1',
      turnCount: 2,
      seqIndex: 1,
      messages,
    });
  }

  it('injects the silence reminder past the threshold of quiet tool calls', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('Read', 'Bash', 'Write', 'Glob', 'Grep', 'Read', 'Bash'),
    ];
    const effect = run(messages);
    expect(effect).toEqual({
      type: 'inject',
      injection: SEND_MESSAGE_REMINDER_MESSAGE,
      source: 'send_message_reminder',
    });
  });

  it('stays silent at exactly the threshold', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('Read', 'Bash', 'Write', 'Glob', 'Grep', 'Read'),
    ];
    expect(run(messages)).toBeUndefined();
  });

  it('injects the early-result reminder once when working after a sent message', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('SendMessage'),
      toolResultTurn(),
      assistantWithTools('Read'),
    ];
    const effect = run(messages);
    expect(effect).toEqual({
      type: 'inject',
      injection: EARLY_RESULT_REMINDER_MESSAGE,
      source: 'send_message_reminder',
    });
    // Latched: a reminder already in the streak suppresses a second fire.
    expect(run([...messages.slice(0, -1), reminderTurn('early'), assistantWithTools('Bash')])).toBeUndefined();
  });

  it('does not fire when the newest message is itself a reminder', () => {
    const messages = [
      userTurn('go'),
      assistantWithTools('Read', 'Bash', 'Write', 'Glob', 'Grep', 'Read', 'Bash'),
      reminderTurn('silence'),
    ];
    expect(run(messages)).toBeUndefined();
  });

  it('does not fire for a fresh turn with no tool activity', () => {
    expect(run([userTurn('hi'), assistantWithText('thinking...')])).toBeUndefined();
  });

  it('is registered by createBuiltinLoopHooks only when enabled', async () => {
    const { createBuiltinLoopHooks } = await import('../builtin.js');
    const withHook = createBuiltinLoopHooks({
      todoGateEnabled: false,
      antiDeadLoop: { enabled: false, nudgeAt: 8, hardNudgeAt: 12 },
      toolIntentNudgeMax: 0,
      sendMessageReminder: { enabled: true },
    });
    expect(withHook.some((h) => h.id === 'builtin.send-message-reminder')).toBe(true);

    const withoutHook = createBuiltinLoopHooks({
      todoGateEnabled: false,
      antiDeadLoop: { enabled: false, nudgeAt: 8, hardNudgeAt: 12 },
      toolIntentNudgeMax: 0,
      sendMessageReminder: { enabled: false },
    });
    expect(withoutHook.some((h) => h.id === 'builtin.send-message-reminder')).toBe(false);
  });
});

/**
 * SendMessage reminder loop hook (grok SendMessageReminderMiddleware port).
 *
 * grok-bot enforces "SendMessage is the bot's only voice" at runtime with a
 * middleware that runs before every model round: it counts non-SendMessage
 * tool calls since the last SendMessage and injects a `<system_reminder>`
 * nudge when the bot goes quiet on a user who is watching. Ported here as a
 * builtin PreTurn hook on the LoopHookBus (plan 426) so the injection rides
 * the single runtime-context channel (transient, never persisted).
 *
 * Two nudges (verbatim texts, thresholds, and latching semantics from
 * grok-bot 0.18 `send-message-reminder-middleware.ts`):
 * - Silence reminder: more than `threshold` (default 6) non-SendMessage tool
 *   calls since the last SendMessage — the user is watching silence.
 * - Early-result reminder: the bot already sent something this turn but has
 *   since produced tool output without delivering it (ack ≠ delivery
 *   reinforcement). Fires once per silent streak.
 *
 * Pure predicate functions are exported for unit testing; they operate on the
 * provider-turn Message shape (`@duya/ai`), not grok's MessageLike.
 */

import type { LoopHookRegistration } from './loop.js';
import { SEND_MESSAGE_TOOL_NAME } from '../tool/SendMessageTool/constants.js';

export const SEND_MESSAGE_REMINDER_HOOK_ID = 'builtin.send-message-reminder';

/** grok default: inject the silence reminder after 6 quiet tool calls. */
export const DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD = 6;
/** grok default: early-result reminder after any quiet tool call (> 0). */
export const DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD = 0;

export const SEND_MESSAGE_REMINDER_MESSAGE =
  'You have made several tool calls without a SendMessage, so the user is currently ' +
  'watching silence. Actually invoke the SendMessage tool now. Send a brief, specific ' +
  'update on what you are doing or what you just found before continuing.';

export const EARLY_RESULT_REMINDER_MESSAGE =
  'Remember: the user cannot see tool output or your thinking — only SendMessage reaches ' +
  'them. If you have produced a result or finished what they asked, send it now with ' +
  'SendMessage tool call before continuing or ending the turn. If you are still mid-task, ' +
  'keep working and send the result once you have it.';

/**
 * grok `USER_MESSAGE_REPLY_REMINDER` (plan 496 L2): injected on the first
 * model round of a user-facing bot run, adjacent to the fresh user turn.
 * Lives here with the other reminder texts so
 * {@link isSendMessageReminderMessage} recognizes it without a circular
 * import of `./send-message-delivery.ts` (whose walk helpers need this
 * predicate).
 */
export const USER_MESSAGE_REPLY_REMINDER =
  'Reply to this message by actually invoking the SendMessage tool — make a real ' +
  'tool/function call, not text you write. Plain assistant text is NEVER delivered; ' +
  'only a real SendMessage tool invocation reaches the user, so if you don\'t invoke ' +
  'the tool they just see silence.';

/**
 * Marker metadata carried on projected reminder turns
 * (`projectRuntimeContextToProviderMessage` copies `source` into
 * `metadata.source`), plus a content fallback so reminders remain
 * recognizable even if they round-trip through a persistence layer that
 * drops metadata.
 */
export function isSendMessageReminderMessage(message: unknown): boolean {
  const m = message as
    | { role?: string; content?: unknown; metadata?: { source?: unknown } }
    | null
    | undefined;
  if (!m) return false;
  if (m.metadata?.source === 'send_message_reminder') return true;
  if (m.role !== 'user') return false;
  const text = getUserMessageText(m);
  return (
    text !== undefined &&
    (text.includes(SEND_MESSAGE_REMINDER_MESSAGE) ||
      text.includes(EARLY_RESULT_REMINDER_MESSAGE) ||
      text.includes(USER_MESSAGE_REPLY_REMINDER))
  );
}

function getUserMessageText(message: {
  content?: unknown;
}): string | undefined {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

interface ToolUsePart {
  type: 'tool_use';
  name: string;
}

function toolUseParts(message: {
  role?: string;
  content?: unknown;
}): ToolUsePart[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.filter(
    (part): part is ToolUsePart =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'tool_use' &&
      typeof (part as { name?: unknown }).name === 'string',
  );
}

/** Does this assistant turn contain a SendMessage tool call? */
export function hasSendMessageCall(message: unknown): boolean {
  const m = message as { role?: string; content?: unknown } | null | undefined;
  if (!m) return false;
  return toolUseParts(m).some(isDeliveryCall);
}

/** Non-delivery tool calls in one assistant turn (0 for other roles). */
export function countNonSendMessageToolCalls(message: unknown): number {
  const m = message as { role?: string; content?: unknown } | null | undefined;
  if (!m) return 0;
  return toolUseParts(m).filter((part) => !isDeliveryCall(part)).length;
}

/**
 * Plan 501 L2: a delivery is any tool that puts words in front of an
 * audience — SendMessage (the user voice) and post_to_room (a group
 * member's voice, plan 478). Without the latter the delivery-owed check
 * reads a room turn that already spoke as silent.
 */
function isDeliveryCall(part: ToolUsePart): boolean {
  return part.name === SEND_MESSAGE_TOOL_NAME || part.name === 'post_to_room';
}

/**
 * Walk backward from the newest message counting non-SendMessage tool calls,
 * stopping at the first user/system turn or SendMessage call — grok's
 * `countToolCallsSinceLastSendMessage`.
 */
export function countToolCallsSinceLastSendMessage(
  messages: readonly unknown[],
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: unknown }
      | null
      | undefined;
    if (message == null) continue;
    if (message.role === 'user' || message.role === 'system') break;
    if (hasSendMessageCall(message)) break;
    count += countNonSendMessageToolCalls(message);
  }
  return count;
}

/**
 * Whether a SendMessage call happened since the last real user turn — grok's
 * `hasSendMessageSinceRealTurnStart`. Injected reminder turns are skipped so
 * they never masquerade as the start of the conversation.
 */
export function hasSendMessageSinceRealTurnStart(
  messages: readonly unknown[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: unknown }
      | null
      | undefined;
    if (message == null) continue;
    if (isSendMessageReminderMessage(message)) continue;
    if (message.role === 'user' || message.role === 'system') return false;
    if (hasSendMessageCall(message)) return true;
  }
  return false;
}

/**
 * Whether a reminder already fired in the current silent streak — grok's
 * `hasReminderFiredThisSilentStreak`. A streak ends at a real user turn or a
 * SendMessage call; reminder turns themselves are skipped (checked before the
 * user-role break, since reminders project to user-role turns).
 */
export function hasReminderFiredThisSilentStreak(
  messages: readonly unknown[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as
      | { role?: string; content?: unknown }
      | null
      | undefined;
    if (message == null) continue;
    if (isSendMessageReminderMessage(message)) return true;
    if (message.role === 'user' || message.role === 'system') return false;
    if (hasSendMessageCall(message)) return false;
  }
  return false;
}

export interface SendMessageReminderOptions {
  /** Gate: only bot runs (SendMessage in the toolset) register the hook. */
  enabled: boolean;
  threshold?: number;
  earlyResultThreshold?: number;
}

/**
 * Build the PreTurn hook registration. Mirrors the middleware's `stream()`
 * gate: skip when the newest message is itself a reminder (the nudge is
 * already the model's pending context), otherwise fire silence first and
 * early-result second, exactly one injection per round.
 */
export function createSendMessageReminderHook(
  options: SendMessageReminderOptions,
): LoopHookRegistration {
  const threshold = options.threshold ?? DEFAULT_SEND_MESSAGE_REMINDER_THRESHOLD;
  const earlyResultThreshold =
    options.earlyResultThreshold ?? DEFAULT_EARLY_RESULT_REMINDER_THRESHOLD;
  return {
    id: SEND_MESSAGE_REMINDER_HOOK_ID,
    events: ['PreTurn'],
    handler: (ctx) => {
      const messages = ctx.messages;
      const last = messages.at(-1);
      if (last != null && isSendMessageReminderMessage(last)) return;
      const count = countToolCallsSinceLastSendMessage(messages);
      if (count > threshold) {
        return {
          type: 'inject',
          injection: SEND_MESSAGE_REMINDER_MESSAGE,
          source: 'send_message_reminder',
        };
      }
      if (
        count > earlyResultThreshold &&
        hasSendMessageSinceRealTurnStart(messages) &&
        !hasReminderFiredThisSilentStreak(messages)
      ) {
        return {
          type: 'inject',
          injection: EARLY_RESULT_REMINDER_MESSAGE,
          source: 'send_message_reminder',
        };
      }
      return;
    },
  };
}

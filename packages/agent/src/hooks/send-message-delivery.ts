/**
 * SendMessage delivery enforcement hooks (grok turn-runtime port).
 *
 * grok-bot 0.18 enforces "SendMessage is the bot's only voice" with two
 * layers this file ports (plan 496): the per-user-message reply reminder
 * (`USER_MESSAGE_REPLY_REMINDER`, grok `appendUserReplyReminder`) and the
 * turn-end delivery check (`ensureUserReply` → `REPLY_NUDGE_PROMPT` /
 * `CLOSING_SEND_NUDGE_PROMPT`). The mid-turn silence/early-result nudges
 * already live in `./send-message-reminder.ts` (grok
 * `SendMessageReminderMiddleware` port); this file completes the L2 + L4
 * layers so a bot that ends a user-facing turn without any SendMessage
 * cannot finalize silently.
 *
 * Two loop-hook registrations:
 * - PreTurn (`builtin.send-message-reply-reminder`): on the first model
 *   round of a run, when the newest message is a real user turn, inject the
 *   reply reminder so even a two-token "hi" carries the delivery contract.
 * - PreFinalize (`builtin.send-message-delivery`, priority 25, before
 *   todo-gate (30)): before the run may finalize,
 *   check delivery owed — no SendMessage call since the last real user
 *   turn — and veto with the reply nudge, capped at `MAX_SEND_MESSAGE_
 *   NUDGES` per run; if a send happened earlier but the turn is ending on
 *   silent tool calls, fire the closing-send nudge once (grok
 *   `turnEndedOnSilentToolCalls`).
 *
 * Both hooks are registered only for user-facing bot runs: callers gate on
 * the SendMessage tool being in the toolset and `silenceAllowed` false
 * (wake/automation/background-resume runs keep grok's isSilenceAllowed
 * exemption — commsRules already tells the model quiet runs may stay
 * silent). Failure isolation and the injection channel follow the loop-hook
 * bus contract in `./loop.ts`.
 */

import type { LoopHookRegistration } from './loop.js';
import { logger } from '../utils/logger.js';
import {
  countToolCallsSinceLastSendMessage,
  hasSendMessageSinceRealTurnStart,
  isSendMessageReminderMessage,
  USER_MESSAGE_REPLY_REMINDER,
} from './send-message-reminder.js';

export const SEND_MESSAGE_REPLY_REMINDER_HOOK_ID = 'builtin.send-message-reply-reminder';
export const SEND_MESSAGE_DELIVERY_HOOK_ID = 'builtin.send-message-delivery';

/** grok default: at most 3 hidden nudge rounds per run, then give up. */
export const MAX_SEND_MESSAGE_NUDGES = 3;

/**
 * grok `REPLY_NUDGE_PROMPT`, adapted to the in-run veto phrasing: the turn
 * is still open when this fires (block_finalize), so "this turn" instead of
 * "your previous turn".
 */
export const REPLY_NUDGE_INJECTION =
  'The user is still waiting and this turn has delivered nothing: no SendMessage tool ' +
  'call has happened since their message, so every word you have written so far is ' +
  'invisible to them. Do not assume something you said earlier covered it — an opening ' +
  'acknowledgement did not deliver anything (ack ≠ delivery). Deliver now by actually ' +
  'invoking the SendMessage tool — make a real tool/function call, not text you write. ' +
  'Plain assistant text is NEVER shown to the user; only a real SendMessage tool ' +
  'invocation reaches them. If the work is genuinely unfinished, still send a brief, ' +
  'specific status of where things stand before continuing.';

/**
 * grok `CLOSING_SEND_NUDGE_PROMPT`: the turn acknowledged the user, then ran
 * tool calls, and is about to end without a follow-up SendMessage.
 */
export const CLOSING_SEND_NUDGE_INJECTION =
  'Your turn acknowledged the user and then ran tool calls, but is ending without a ' +
  'follow-up SendMessage — the last thing the user saw is that opening acknowledgement, ' +
  'so whatever the tool calls produced after it never reached them. If that work ' +
  'produced the result or answer they are waiting on, deliver it now by actually ' +
  'invoking the SendMessage tool — make a real tool/function call, not text you write. ' +
  'Plain assistant text is NEVER shown to the user; only a real SendMessage tool ' +
  'invocation reaches them. If the work is genuinely unfinished, continue it and send ' +
  'the result once you have it.';

interface LooselyTypedMessage {
  role?: string;
  content?: unknown;
  metadata?: Record<string, unknown> | null;
}

function userMessageText(message: LooselyTypedMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
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

/**
 * A real user turn: user role, non-empty text, not a loop-hook reminder and
 * not another runtime-context projection (mailbox, background notification,
 * mode reminders all project to user-role turns too — grok treats every
 * user-role turn as a conversation boundary, and so do the walk helpers in
 * `./send-message-reminder.ts`).
 */
export function isRealUserMessage(message: unknown): boolean {
  const m = message as LooselyTypedMessage | null | undefined;
  if (!m || m.role !== 'user') return false;
  if (isSendMessageReminderMessage(m)) return false;
  if (m.metadata?.runtimeContext === true) return false;
  return userMessageText(m).trim().length > 0;
}

/** Whether the conversation contains any real user turn at all. */
export function hasRealUserTurn(messages: readonly unknown[]): boolean {
  return messages.some((message) => isRealUserMessage(message));
}

/**
 * grok `isDeliveryOwed` for the duya message shape: a real user turn exists
 * and no SendMessage call has happened since the newest one. Injected
 * reminder turns are skipped by the walk helpers, so a fired nudge never
 * masks the still-missing delivery.
 */
export function isDeliveryOwed(messages: readonly unknown[]): boolean {
  if (!hasRealUserTurn(messages)) return false;
  return !hasSendMessageSinceRealTurnStart(messages);
}

export interface SendMessageDeliveryOptions {
  /**
   * Gate: only bot runs (SendMessage in the run's toolset) can deliver via
   * SendMessage, so only those register the hooks.
   */
  enabled: boolean;
  /**
   * grok isSilenceAllowed: wake / automation / background-resume runs may
   * legitimately end without a SendMessage (commsRules' quiet-work
   * exemption), so they get neither the reply reminder nor the delivery
   * vetoes.
   */
  silenceAllowed?: boolean;
}

/**
 * L2 — reply reminder on the first model round of the run. Fires exactly
 * once (turnCount === 1) and only when the newest message is the real user
 * prompt: later rounds tail with assistant/tool turns, so the condition
 * cannot re-fire mid-run.
 */
export function createSendMessageReplyReminderHook(
  options: SendMessageDeliveryOptions,
): LoopHookRegistration {
  return {
    id: SEND_MESSAGE_REPLY_REMINDER_HOOK_ID,
    events: ['PreTurn'],
    handler: (ctx) => {
      if (!options.enabled || options.silenceAllowed === true) return;
      if (ctx.turnCount !== 1) return;
      const last = ctx.messages.at(-1);
      if (!isRealUserMessage(last)) return;
      logger.info('[Agent] Injecting SendMessage reply reminder on user turn start');
      return {
        type: 'inject',
        injection: USER_MESSAGE_REPLY_REMINDER,
        source: 'send_message_reminder',
      };
    },
  };
}

/**
 * L4 — turn-end delivery check. Vetoes finalize while delivery is owed
 * (capped) or the turn is closing on silent tool calls (once per run).
 */
export function createSendMessageDeliveryHook(
  options: SendMessageDeliveryOptions,
): LoopHookRegistration {
  let nudgeCount = 0;
  let closingNudgeFired = false;
  return {
    id: SEND_MESSAGE_DELIVERY_HOOK_ID,
    events: ['PreFinalize'],
    priority: 25,
    handler: (ctx) => {
      if (!options.enabled || options.silenceAllowed === true) return;
      if (isDeliveryOwed(ctx.messages)) {
        if (nudgeCount >= MAX_SEND_MESSAGE_NUDGES) {
          // grok `reportTurnEmptyDelivery` equivalent: the enforcement gave
          // up — surface it in the log so regressions stay observable.
          logger.warn(
            `[Agent] Turn ${ctx.turnCount}: delivery still owed after ${nudgeCount} SendMessage nudges; finalizing empty`,
          );
          return;
        }
        nudgeCount += 1;
        logger.info(
          `[Agent] Turn ${ctx.turnCount}: no SendMessage since user turn; nudging delivery (${nudgeCount}/${MAX_SEND_MESSAGE_NUDGES})`,
        );
        return {
          type: 'block_finalize',
          injection: REPLY_NUDGE_INJECTION,
          source: 'send_message_reminder',
        };
      }
      const silentTail = countToolCallsSinceLastSendMessage(ctx.messages);
      if (
        !closingNudgeFired &&
        silentTail > 0 &&
        hasSendMessageSinceRealTurnStart(ctx.messages)
      ) {
        closingNudgeFired = true;
        logger.info(
          `[Agent] Turn ${ctx.turnCount}: closing on ${silentTail} silent tool call(s) after an acknowledgement; nudging closing send`,
        );
        return {
          type: 'block_finalize',
          injection: CLOSING_SEND_NUDGE_INJECTION,
          source: 'send_message_reminder',
        };
      }
      return;
    },
  };
}

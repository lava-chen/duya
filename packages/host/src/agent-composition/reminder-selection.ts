/**
 * Plan 624 F1 — the reminder decision inside the composition layer.
 *
 * The pure cadence rule lives next to this module in `time-reminder.ts` so it
 * can be tested without a session and stay free of IO. This module is the host
 * policy point: it picks the defaults, derives the compaction window, and
 * turns a decision into the text the context rail should carry this turn.
 *
 * Duya's rail is rebuilt from the timeline every request and is deliberately
 * absent from it, so "append a new developer message" is not available here.
 * An emission refreshes the `turn_time` block; between emissions the block
 * keeps the last text. What codex gains by appending history, this layer gains
 * by never accumulating it — the two behaviours are NOT equivalent and must
 * not be described as such.
 */
import {
  decideTimeReminder,
  renderTimeReminder,
  renderTimeUnavailable,
  type TimeReminderDeliveryMode,
  type TimeReminderEmissionState,
  type TimeReminderReason,
  type TimeReminderTurnKind,
} from './time-reminder.js';

import type { CompositionDecision } from './contract.js';

/** Conservative default: a reminder no more than once every five minutes. */
export const DEFAULT_TIME_REMINDER_INTERVAL_SECONDS = 300;

/** Do not interrupt a pure assistant turn with a clock update. */
export const DEFAULT_TIME_REMINDER_DELIVERY_MODE: TimeReminderDeliveryMode =
  'after-user-or-tool-output';

export interface TimeReminderSelectionInput {
  readonly nowMs: number;
  /** Compaction epoch; a different value forces a re-emission. */
  readonly windowId: string;
  readonly turnKind: TimeReminderTurnKind;
  readonly state: TimeReminderEmissionState;
  readonly clockAvailable?: boolean;
  readonly intervalSeconds?: number;
  readonly deliveryMode?: TimeReminderDeliveryMode;
}

/** Stable slot name for the live-clock block on the volatile rail. */
export const TIME_REMINDER_BLOCK_ID = 'turn_time';

export interface TimeReminderSelection {
  /** Text for the `turn_time` rail block, undefined before the first emission. */
  readonly content?: string;
  readonly state: TimeReminderEmissionState;
  readonly reason: TimeReminderReason;
  readonly decisions: readonly CompositionDecision[];
}

/** The selection plus the rail block the caller should append, if any. */
export interface TimeReminderBlockSelection extends TimeReminderSelection {
  readonly block?: {
    readonly id: typeof TIME_REMINDER_BLOCK_ID;
    readonly source: typeof TIME_REMINDER_BLOCK_ID;
    readonly content: string;
  };
}

/**
 * Classify what triggered this inference. A user-role message carrying a
 * `tool_result` is tool output, not a human turn; a trailing assistant message
 * means the model is continuing its own turn.
 */
export function inferTimeReminderTurnKind(
  lastMessage: { readonly role?: string; readonly content?: unknown } | undefined,
): TimeReminderTurnKind {
  if (!lastMessage) return 'user';
  if (lastMessage.role === 'assistant') return 'assistant';
  if (lastMessage.role === 'user') {
    const content = lastMessage.content;
    const hasToolResult =
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          (block as { type?: unknown }).type === 'tool_result',
      );
    return hasToolResult ? 'tool' : 'user';
  }
  return 'user';
}

export function resolveTimeReminder(input: TimeReminderSelectionInput): TimeReminderBlockSelection {
  const intervalSeconds = input.intervalSeconds ?? DEFAULT_TIME_REMINDER_INTERVAL_SECONDS;
  const deliveryMode = input.deliveryMode ?? DEFAULT_TIME_REMINDER_DELIVERY_MODE;
  const clockAvailable = input.clockAvailable ?? true;
  const decision = decideTimeReminder({
    nowMs: input.nowMs,
    windowId: input.windowId,
    intervalSeconds,
    deliveryMode,
    turnKind: input.turnKind,
    state: input.state,
    clockAvailable,
  });

  const decisions: CompositionDecision[] = [
    {
      field: 'reminders.time',
      value: decision.reason,
      source: decision.emit ? 'config' : 'host-default',
      note: `interval=${intervalSeconds}s delivery=${deliveryMode} window=${input.windowId}`,
    },
  ];

  const emittedContent = decision.emit
    ? clockAvailable
      ? renderTimeReminder(input.nowMs)
      : renderTimeUnavailable()
    : undefined;
  const content = emittedContent ?? input.state.lastContent;
  const state: TimeReminderEmissionState =
    emittedContent === undefined
      ? input.state
      : {
          lastEmittedAtMs: input.nowMs,
          emittedWindowId: input.windowId,
          lastContent: emittedContent,
        };
  return {
    ...(content === undefined ? {} : { content }),
    ...(content === undefined
      ? {}
      : {
          block: {
            id: TIME_REMINDER_BLOCK_ID,
            source: TIME_REMINDER_BLOCK_ID,
            content,
          },
        }),
    state,
    reason: decision.reason,
    decisions,
  };
}

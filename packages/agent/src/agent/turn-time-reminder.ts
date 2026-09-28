/**
 * turn-time-reminder.ts — wall-clock snapshot injected after the current
 * turn's user message at the per-request boundary.
 *
 * Replaces the old `Current date and time:` line in the environment
 * system-prompt section (plan 560 layout). The system-prompt line only
 * refreshed per `buildSystemPrompt` call and sat inside the cache-able
 * prefix; attaching the time to the user message per request keeps it
 * accurate mid-turn (fresh timestamp on every model request) without
 * perturbing the stable system prompt.
 *
 * Applied centrally in `DuyaAgent.streamChat`, so every profile (general /
 * bot / code / config-driven) gets it. Never persisted: the injection
 * mutates only the projected `llmMessages` array and replaces the target
 * message with a shallow copy — the durable timeline keeps the original
 * content, so the renderer never shows the block.
 */

import { formatCurrentDateTime } from '../prompts/dynamic/environment.js';
import { renderSystemReminder } from './reminders.js';

/** Minimal message shape the injector needs (Message-compatible). */
interface InjectableMessage {
  id?: string;
  content: string | ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * Build the `<system-reminder>` block carrying the current time.
 * Body format matches the old environment line so the model contract is
 * unchanged: `Current time: Monday, September 28, 2026, 10:44:43 (TZ, GMT+8)`.
 */
export function buildTurnTimeReminder(nowMs: number, tzStr?: string): string {
  return renderSystemReminder(
    `Current time: ${formatCurrentDateTime(nowMs, tzStr)}`,
    'turn_time',
  );
}

/**
 * Append the time reminder to the current turn's user message
 * (looked up by `runtimePromptMessageId`) inside `messages` — the
 * projected per-request array, not the durable history.
 *
 * Non-mutating on the source message object: the entry in `messages`
 * is replaced with a shallow copy whose `content` is a fresh
 * string/array. Returns true when injected.
 */
export function injectTurnTimeReminder(
  messages: InjectableMessage[],
  runtimePromptMessageId: string | null,
  nowMs: number = Date.now(),
  tzStr?: string,
): boolean {
  if (!runtimePromptMessageId) return false;

  const index = messages.findIndex((m) => m.id === runtimePromptMessageId);
  if (index < 0) return false;

  const target = messages[index];
  const reminder = buildTurnTimeReminder(nowMs, tzStr);

  if (typeof target.content === 'string') {
    messages[index] = { ...target, content: `${target.content}\n\n${reminder}` };
    return true;
  }
  if (Array.isArray(target.content)) {
    messages[index] = {
      ...target,
      content: [...target.content, { type: 'text', text: reminder }],
    };
    return true;
  }
  return false;
}

/**
 * turn-time-reminder.ts — Persistent Turn Context Injection: wall-clock
 * turn timestamps rendered deterministically into provider requests.
 *
 * Design (C′): the durable timeline stores the user's ORIGINAL content —
 * never the reminder text. The injection source is reconstructible state:
 *   - payload  = `message.timestamp` (epoch ms, already persisted as
 *     `created_at` and restored by the session DB loader)
 *   - rule     = versioned in code (`TURN_TIMESTAMP_REMINDER_VERSION`) so
 *     replay is deterministic across restarts without extra DB columns
 *   - renderer = request assembly only (`injectTurnTimestampReminders`)
 *
 * Byte-stability contract (prompt-cache critical):
 *   - Timestamps render in UTC ISO-8601 seconds (`2026-09-28T02:50:31Z`)
 *     via a fixed formatter — no locale, no system-timezone dependency, so
 *     the same message yields identical bytes on every replay forever.
 *   - Every human-turn user message in history gets its reminder on EVERY
 *     request (append-only prompt history): historical turns keep their
 *     reminder bytes stable, so the provider cache prefix stays intact
 *     across turns — the injection point never diverges.
 *   - A message rendered once must never be re-rendered differently later;
 *     if the format ever changes, bump the version and accept the one-time
 *     cache reset it implies.
 *
 * Applied centrally in `DuyaAgent.streamChat`, so every profile (general /
 * bot / code / config-driven) gets it. UI, DB content, exports, and
 * compaction summaries all read the clean canonical content.
 */

/** Wire format version. Bump ONLY on a deliberate format change. */
export const TURN_TIMESTAMP_REMINDER_VERSION = 1;

/** Minimal message shape the injector needs (Message-compatible). */
interface InjectableMessage {
  id?: string;
  role?: string;
  content: string | ReadonlyArray<{ type: string; text?: string }>;
  source?: string;
  metadata?: Readonly<Record<string, unknown>>;
  timestamp?: number;
  /** Compaction-summary projection flag (message-projectors.ts). */
  isCompactSummary?: boolean;
  compactBoundaryId?: string;
}

/**
 * Format an epoch-ms timestamp as canonical UTC ISO-8601 seconds.
 * Pure function of the epoch value: no locale, no timezone offset, no
 * milliseconds — replay-safe by construction.
 */
export function formatCanonicalTurnTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Locked reminder body for version 1. Spaces/newlines must not drift. */
export function renderTurnTimestampReminderBody(atIso: string): string {
  return `Message sent at ${atIso}.`;
}

/**
 * Version-1 rule deciding which messages carry the turn timestamp.
 * Targets human turns only: user-role, plain text/image content, not a
 * harness injection — runtime context, wake-run `source: 'system'`,
 * compaction-summary continuations, and synthetic tool_result carriers are
 * all excluded. Timestamps <= 0 are harness artifacts (epoch 0), not real
 * send times. The rule reads only persisted / deterministic properties so
 * reconstruction is identical after a session reload.
 */
export function isHumanTurnUserMessage(
  message: InjectableMessage,
): boolean {
  if (message.role !== 'user') return false;
  if (message.source === 'system') return false;
  if (message.metadata?.runtimeContext === true) return false;
  if (message.isCompactSummary === true || message.compactBoundaryId !== undefined) {
    return false;
  }
  if (message.timestamp === undefined || message.timestamp <= 0) return false;
  if (Array.isArray(message.content)) {
    return !message.content.some((c) => c.type === 'tool_result');
  }
  return true;
}

/** Build the version-1 `<system-reminder>` block for a message timestamp. */
export function buildTurnTimestampReminder(timestampMs: number): string {
  const body = renderTurnTimestampReminderBody(
    formatCanonicalTurnTimestamp(timestampMs),
  );
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * Append the turn-timestamp reminder after every human-turn user message
 * in `messages` — the projected per-request array, not the durable history.
 *
 * Non-mutating on the source message objects: each injected entry is
 * replaced with a shallow copy whose `content` is a fresh string/array.
 * Returns the number of messages injected.
 */
export function injectTurnTimestampReminders(
  messages: InjectableMessage[],
): number {
  let injected = 0;
  for (let i = 0; i < messages.length; i++) {
    const target = messages[i];
    if (!isHumanTurnUserMessage(target)) continue;

    const reminder = buildTurnTimestampReminder(target.timestamp as number);
    if (typeof target.content === 'string') {
      messages[i] = { ...target, content: `${target.content}\n\n${reminder}` };
      injected++;
    } else if (Array.isArray(target.content)) {
      messages[i] = {
        ...target,
        content: [...target.content, { type: 'text', text: reminder }],
      };
      injected++;
    }
  }
  return injected;
}

/**
 * Deprecated compatibility shim for the pre-C′ call site in
 * `DuyaAgent.streamChat` (which still passes a turn-scoped `nowMs`).
 * Delegates to {@link injectTurnTimestampReminders}: the reminder is now
 * rendered deterministically from each message's persisted timestamp, so
 * the `runtimePromptMessageId` / `nowMs` parameters are ignored. Remove
 * once DuyaAgent calls the new entry point directly.
 *
 * @deprecated use {@link injectTurnTimestampReminders}.
 */
export function injectTurnTimeReminder(
  messages: InjectableMessage[],
  _runtimePromptMessageId: string | null,
  _nowMs?: number,
  _tzStr?: string,
): boolean {
  return injectTurnTimestampReminders(messages) > 0;
}

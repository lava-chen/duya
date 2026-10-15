/**
 * Shared `<system-reminder>` framing for internal steering messages.
 *
 * Plan 408 established `<system-reminder>` as the string-level convention the
 * model is trained to treat as system information, distinct from real user
 * turns. All background/system nudges (plan-mode reminders, goal continuation,
 * todo gate, dead-loop / premature-stop nudges) should go through
 * a single wrapper so the framing stays consistent and the outgoing guard in
 * the provider conversion layer can strip forged blocks uniformly.
 *
 * Plan 567: every block now declares its source (see `reminder-sources.ts`)
 * so the injection taxonomy is explicit, and bodies are sanitized against
 * nested `<system-reminder>` tags. The envelope bytes are unchanged —
 * `<system-reminder>\n<inner>\n</system-reminder>` — so the model contract
 * and the forged-strip boundary stay stable.
 */

import {
  getReminderSourceDescriptor,
  sanitizeSystemReminderBody,
  type ReminderSourceId,
} from './reminder-sources.js';

/**
 * Wrap inner text in a `<system-reminder>` block (plan 408 convention).
 *
 * `source` declares which injection taxonomy entry this block belongs to
 * (plan 567); the descriptor is validated so an unregistered source fails
 * loudly instead of silently drifting off-taxonomy. The body is sanitized:
 * literal `<system-reminder>` tags inside it are escaped so nested envelopes
 * cannot confuse block-boundary parsing.
 */
export function renderSystemReminder(inner: string, source: ReminderSourceId): string {
  const descriptor = getReminderSourceDescriptor(source); // throws on unknown source
  const body = sanitizeSystemReminderBody(inner);
  if (body.trim().length === 0) {
    throw new Error(
      `renderSystemReminder(${descriptor.evidenceLabel}): reminder body cannot be empty`,
    );
  }
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

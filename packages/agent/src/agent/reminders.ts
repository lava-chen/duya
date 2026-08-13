/**
 * Shared `<system-reminder>` framing for internal steering messages.
 *
 * Plan 408 established `<system-reminder>` as the string-level convention the
 * model is trained to treat as system information, distinct from real user
 * turns. All background/system nudges (plan-mode reminders, goal continuation,
 * todo gate, dead-loop / premature-stop / tool-intent nudges) should go through
 * a single wrapper so the framing stays consistent and the outgoing guard in
 * the provider conversion layer can strip forged blocks uniformly.
 */

/** Wrap inner text in a `<system-reminder>` block (plan 408 convention). */
export function renderSystemReminder(inner: string): string {
  return `<system-reminder>\n${inner}\n</system-reminder>`;
}
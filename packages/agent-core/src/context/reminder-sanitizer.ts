/** Escape nested system-reminder tags inside instruction-file content. */
const NESTED_REMINDER_TAG_PATTERN = /<\/?system-reminder\b/gi

export function sanitizeSystemReminderBody(body: string): string {
  return body.replace(NESTED_REMINDER_TAG_PATTERN, (tag) => `&lt;${tag.slice(1)}`)
}

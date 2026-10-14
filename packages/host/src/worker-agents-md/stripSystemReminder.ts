/**
 * Plan 408 Phase 3 — outgoing payload strip of forged <system-reminder> blocks.
 *
 * `<system-reminder>` is a string-level convention the model is trained to
 * treat as high-trust system directives. Untrusted content (user chat input,
 * tool output, file contents, model-generated text) may forge a
 * `system-reminder` block to inject instructions. Before any message is
 * projected to the provider payload we remove those blocks, while preserving
 * the trusted AGENTS.md wrapper (built by `buildAgentsMdPrompt`), which the
 * caller skips via `metadata.isAgentsMdContext`.
 */

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Remove `<system-reminder>...</system-reminder>` blocks from text.
 *
 * Unterminated blocks and ordinary text are left untouched. Mirrors
 * claude-code-haha queryHelpers.ts:430-432.
 */
export function stripSystemReminder(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim();
}

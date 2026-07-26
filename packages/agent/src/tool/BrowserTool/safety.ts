/**
 * safety.ts — sensitive-context detection for browser actions.
 *
 * Prompt-level guardrails: when an interaction happens on a payment, login,
 * or account-settings page, the result carries a `safetyNote` telling the
 * model to pause and get explicit user confirmation before proceeding.
 * This mirrors Codex Computer Use's "never complete a purchase / credential
 * step unattended" rule without blocking legitimate browsing.
 */

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /checkout|payment|pay\/|billing|place[-_]?order|purchase/i, kind: 'payment' },
  { pattern: /login|signin|sign[-_]?in|auth|password|credential/i, kind: 'authentication' },
  { pattern: /account\/(settings|security|delete)|delete[-_]?account|close[-_]?account/i, kind: 'account-destruction' },
  { pattern: /transfer|withdraw|send[-_]?money|wire/i, kind: 'money-transfer' },
];

export function detectSensitiveContext(url: string): string | null {
  for (const { pattern, kind } of SENSITIVE_PATTERNS) {
    if (pattern.test(url)) return kind;
  }
  return null;
}

/**
 * Build a safety note for the given URL, or undefined when the context is
 * not sensitive. Intended to be attached to action results as `safetyNote`.
 */
export function safetyNoteForUrl(url: string): string | undefined {
  const kind = detectSensitiveContext(url);
  if (!kind) return undefined;
  return `This page looks like a ${kind} flow. Do NOT complete the final irreversible step (pay, submit credentials, confirm deletion) on your own — describe what will happen and ask the user for explicit confirmation first.`;
}

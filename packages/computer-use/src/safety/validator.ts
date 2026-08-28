/**
 * validator.ts — single validate() function for the safety gates
 * (plan 454 §5 Task C).
 *
 * Shape:
 *   validateKeyCombo({ key, modifiers })   → { allowed, reasons }
 *   validateText(text)                    → { allowed, reasons }
 *   validateMultilineShell(text)          → { allowed, reasons }
 *
 * All checks return the same envelope. Empty `reasons` means the
 * action is allowed. Non-empty `reasons` is a hard refusal — callers
 * should log + surface the reasons to the user.
 *
 * The validator is side-effect free. It never logs, writes files, or
 * touches the OS. Logging + user-facing messaging are the caller's
 * job (audit service / approval UI / tool result envelope).
 */

import {
  BLOCKED_KEY_COMBOS,
  BLOCKED_NEWLINE_SHELL_TOKENS,
  BLOCKED_TEXT_PATTERNS,
  SAFETY_SCAN_MAX_LENGTH,
} from './blocked-patterns.js';

export type SafetyReason = {
  /** Stable code for log/metric correlation. */
  code: string;
  /** Human-readable reason. Safe to surface to the user. */
  reason: string;
};

export interface SafetyVerdict {
  /** True when no reasons were found. */
  allowed: boolean;
  /** Empty when allowed. Each entry has a stable code + reason. */
  reasons: SafetyReason[];
}

/**
 * Compute the canonical modifier set for an input combo: lowercase,
 * trimmed, deduped, sorted for stable comparison.
 */
function canonicalModifiers(
  modifiers: ReadonlyArray<'ctrl' | 'alt' | 'shift' | 'meta'>,
): Set<string> {
  return new Set(modifiers.map((m) => m.toLowerCase().trim()));
}

/**
 * Normalize key text. nut.js uses TitleCase keys like 'Enter' /
 * 'Escape' — we lowercase + trim to align with the BLOCKED list.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().trim();
}

/**
 * Validate a key + modifiers combination against BLOCKED_KEY_COMBOS.
 *
 * - Compares on canonicalized modifier set + normalized key name.
 * - Order-insensitive on modifiers.
 * - Empty modifier set is allowed (just `key` alone).
 */
export function validateKeyCombo(input: {
  key: string;
  modifiers?: ReadonlyArray<'ctrl' | 'alt' | 'shift' | 'meta'>;
}): SafetyVerdict {
  const mods = canonicalModifiers(input.modifiers ?? []);
  const key = normalizeKey(input.key);

  for (const blocked of BLOCKED_KEY_COMBOS) {
    const blockedMods = canonicalModifiers(blocked.modifiers);
    const blockedKey = normalizeKey(blocked.key);

    if (blockedMods.size === mods.size && blockedKey === key) {
      // Modifiers must be a strict superset-equal match — extra
      // modifiers disqualify a match (a blocked `ctrl+q` is not the
      // same as `ctrl+alt+q`).
      let match = true;
      for (const m of blockedMods) {
        if (!mods.has(m)) {
          match = false;
          break;
        }
      }
      if (match) {
        return {
          allowed: false,
          reasons: [
            {
              code: 'BLOCKED_KEY_COMBO',
              reason: blocked.reason,
            },
          ],
        };
      }
    }
  }
  return { allowed: true, reasons: [] };
}

/**
 * Validate text content against BLOCKED_TEXT_PATTERNS.
 *
 * - Whitespace normalization: collapse runs of whitespace into single
 *   spaces before substring matching.
 * - Truncates input to SAFETY_SCAN_MAX_LENGTH before scanning (defense
 *   in depth — schema already caps at 50k chars).
 */
export function validateText(text: string): SafetyVerdict {
  if (text.length === 0) return { allowed: true, reasons: [] };

  const safe = text.length > SAFETY_SCAN_MAX_LENGTH
    ? text.slice(0, SAFETY_SCAN_MAX_LENGTH)
    : text;
  const normalized = safe.replace(/\s+/g, ' ').toLowerCase();

  for (const blocked of BLOCKED_TEXT_PATTERNS) {
    if (normalized.includes(blocked.pattern.toLowerCase())) {
      return {
        allowed: false,
        reasons: [
          {
            code: 'BLOCKED_TEXT_PATTERN',
            reason: blocked.reason,
          },
        ],
      };
    }
  }
  return { allowed: true, reasons: [] };
}

/**
 * Detect newline-then-shell sequences. Looks for `\n` (or `\r\n`)
 * immediately followed by one of BLOCKED_NEWLINE_SHELL_TOKENS.
 *
 * Each match produces one reason. Multi-line payloads may surface
 * multiple reasons; callers should treat any non-empty reason set
 * as a hard refusal.
 */
export function validateMultilineShell(text: string): SafetyVerdict {
  if (text.length === 0) return { allowed: true, reasons: [] };
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { allowed: true, reasons: [] };

  const reasons: SafetyReason[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim().toLowerCase() ?? '';
    if (line.length === 0) continue;
    // First whitespace-separated token.
    const firstToken = line.split(/\s+/, 1)[0];
    if (firstToken && BLOCKED_NEWLINE_SHELL_TOKENS.includes(firstToken)) {
      reasons.push({
        code: 'BLOCKED_NEWLINE_SHELL',
        reason: `line ${i + 1} starts with shell command "${firstToken}" — refusing multi-line shell entry`,
      });
    }
  }
  return reasons.length === 0
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons };
}

/**
 * Convenience: run all three validators and merge results.
 *
 * Use for the `os_type` and `os_set_value` actions where text content
 * is the primary attack surface.
 */
export function validateTextFull(text: string): SafetyVerdict {
  const reasons: SafetyReason[] = [];
  for (const v of [validateText(text), validateMultilineShell(text)]) {
    reasons.push(...v.reasons);
  }
  return reasons.length === 0
    ? { allowed: true, reasons: [] }
    : { allowed: false, reasons };
}
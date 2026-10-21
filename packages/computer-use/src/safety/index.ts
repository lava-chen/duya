/**
 * safety/index.ts — barrel (plan 454 §5 Task C).
 */

export {
  BLOCKED_KEY_COMBOS,
  BLOCKED_TEXT_PATTERNS,
  BLOCKED_NEWLINE_SHELL_TOKENS,
  SAFETY_SCAN_MAX_LENGTH,
} from './blocked-patterns.js';

export {
  validateKeyCombo,
  validateText,
  validateMultilineShell,
  validateTextFull,
  type SafetyReason,
  type SafetyVerdict,
} from './validator.js';
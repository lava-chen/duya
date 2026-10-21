/**
 * blocked-patterns.ts — Phase 3 safety gates (plan 454 §5 Task C).
 *
 * Curated lists of:
 *   - Key combos that must NEVER be issued by automation (cmd+shift+back,
 *     ctrl+alt+delete, etc.). Matched case-insensitively, with the
 *     modifier + key in any order, normalized to lowercase.
 *   - Text patterns that signal dangerous shell-out intent. Matched
 *     as substrings after whitespace normalization.
 *   - Multi-line text patterns: `os_type` that contains a newline
 *     followed by a shell-like command (\n followed by bash / cmd /
 *     powershell / sh / zsh / fish / python / node).
 *
 * The lists are intentionally hard-coded + reviewed. Adding a new
 * pattern requires a PR review (plan §9).
 */

/**
 * Key + modifier combinations that must NEVER be sent.
 *
 * Conventions:
 *   - The key name is the OS-agnostic nut.js Key enum value (lowercase
 *     letters, e.g. 'backspace', 'enter', 'f4', 'q', 'delete').
 *   - Modifiers are an unordered set: ctrl / alt / shift / meta.
 *   - All entries are normalized: lowercase + trimmed.
 *   - `set(['ctrl', 'alt'])` matches `ctrl+alt+X` regardless of order.
 */
export const BLOCKED_KEY_COMBOS: ReadonlyArray<{
  modifiers: ReadonlyArray<'ctrl' | 'alt' | 'shift' | 'meta'>;
  key: string;
  reason: string;
}> = [
  // ── OS-level power operations ────────────────────────────────────────
  {
    modifiers: ['ctrl', 'alt'],
    key: 'delete',
    reason: 'Ctrl+Alt+Delete is a system-reserved combo (SAS)',
  },
  // ── macOS emergency exit ─────────────────────────────────────────────
  {
    modifiers: ['ctrl', 'meta'],
    key: 'q',
    reason: 'Cmd+Ctrl+Q is the macOS force-logout shortcut',
  },
  // ── File-system destructive (broad) ────────────────────────────────────
  {
    modifiers: ['meta', 'shift'],
    key: 'backspace',
    reason: 'Cmd+Shift+Backspace empties the Trash without confirmation on macOS',
  },
  // ── App-wide quit ────────────────────────────────────────────────────
  {
    modifiers: ['alt'],
    key: 'f4',
    reason: 'Alt+F4 closes the foreground window on Windows',
  },
];

/**
 * Text substrings that signal dangerous shell-out or destructive
 * intent. Matched case-insensitively after whitespace normalization.
 *
 * Each pattern carries a reason for audit logs.
 */
export const BLOCKED_TEXT_PATTERNS: ReadonlyArray<{
  pattern: string;
  reason: string;
}> = [
  // ── Pipe-to-shell (download + execute) ────────────────────────────────
  {
    pattern: 'curl | bash',
    reason: 'curl|bash is a classic remote-code-execution pattern',
  },
  {
    pattern: 'curl | sh',
    reason: 'curl|sh is a classic remote-code-execution pattern',
  },
  {
    pattern: 'wget | bash',
    reason: 'wget|bash is a classic remote-code-execution pattern',
  },
  // ── Filesystem wipes ──────────────────────────────────────────────────
  {
    pattern: 'rm -rf /',
    reason: 'rm -rf / wipes the root filesystem',
  },
  {
    pattern: 'rm -rf ~',
    reason: 'rm -rf ~ wipes the user home directory',
  },
  {
    pattern: 'rm -rf *',
    reason: 'rm -rf * is a broad delete without confirmation',
  },
  {
    pattern: 'format c:',
    reason: 'format c: reformats the Windows system drive',
  },
  // ── Disk + privilege escalation ───────────────────────────────────────
  {
    pattern: 'mkfs',
    reason: 'mkfs formats a block device',
  },
  {
    pattern: 'dd if=',
    reason: 'dd if= is a low-level disk write',
  },
  {
    pattern: 'sudo ',
    reason: 'sudo escalates to root / administrator',
  },
];

/**
 * Shell invocation patterns that follow a newline. `os_type` typing
 * "<text>\nbash" would press Enter then type "bash" — refusing this
 * prevents accidental shell entry.
 *
 * Each entry is the leading token after a newline (case-insensitive).
 */
export const BLOCKED_NEWLINE_SHELL_TOKENS: ReadonlyArray<string> = [
  'bash',
  'sh',
  'zsh',
  'fish',
  'cmd',
  'powershell',
  'pwsh',
  'python',
  'python3',
  'node',
  'deno',
  'ruby',
  'perl',
  'osascript',
];

/**
 * Default token budget for a single safety scan. Phase 3 may tune
 * per-action.
 */
export const SAFETY_SCAN_MAX_LENGTH = 100_000;
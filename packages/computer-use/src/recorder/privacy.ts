/**
 * privacy.ts — Recorder privacy guardrails (plan 556 Phase 0 §4.9).
 *
 * Three knobs the design doc puts behind a single gate:
 *
 *  1. Process blacklist (`recorder.blockedApps`): when the foreground
 *     window's process matches, the whole event is dropped before
 *     anything hits the aggregator. Default ships with the common
 *     password-manager executables so a stray focus into 1Password
 *     never produces a `type` event.
 *  2. Password redaction (`element.isPassword`): the keyboard
 *     aggregator still flushes a `type` event so the converter sees
 *     the field, but `text` is replaced with `<redacted>` so nothing
 *     reaches the JSONL on disk. The recorder-service is responsible
 *     for not even buffering keystrokes aimed at a password field —
 *     this module is the second line of defence.
 *  3. Self-window filtering: by the time events reach the recorder-
 *     service they have already been filtered by the hook-worker
 *     against `BrowserWindow.getAllWindows()` pids (Phase 1). This
 *     file does NOT need to duplicate that check; the `AppRef` shape
 *     never carries the duya pid because the worker has already
 *     dropped those events upstream.
 *
 * The defaults below are intentionally conservative. Users can
 * override via config; the recorder-service reads `recorder.blockedApps`
 * from `~/.duya/config.toml` (Phase 5).
 */

/** Text emitted in place of every password field's keystrokes. */
export const REDACTED_TEXT = '<redacted>';

/**
 * Default process-name blacklist.
 *
 * Matched case-insensitively against `AppRef.processName` (the
 * executable name without extension, as returned by `GetForegroundWindow`
 * + WMI query). Add to this array when a new password manager ships;
 * the config-file override is the escape hatch for niche installs.
 */
export const DEFAULT_BLOCKED_PROCESS_NAMES: readonly string[] = [
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'dashlane',
  'enpass',
  'nordpass',
  'roboform',
  'stickypassword',
  'logmeonce',
];

/**
 * Return true when the given app should be excluded from recording.
 * Comparison is case-insensitive and ignores `.exe` suffix variants.
 */
export function shouldDropEventForApp(
  app: Pick<AppRef, 'processName'>,
  blocked: readonly string[] = DEFAULT_BLOCKED_PROCESS_NAMES,
): boolean {
  const normalized = normalizeProcessName(app.processName);
  return blocked.some((name) => normalizeProcessName(name) === normalized);
}

/** Drop the trailing `.exe` and lowercase — the only normalization we need. */
function normalizeProcessName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

/**
 * Redact a `type` event's text when its element is a password field.
 *
 * Returns the (possibly mutated) event. The aggregator may still emit
 * the event — that is by design, so the converter can mark the step
 * with `paramHint: true` per design doc §4.6.
 *
 * Non-`type` events are returned untouched.
 */
export function redactRecorderEvent(
  event: RecorderEvent,
): RecorderEvent {
  if (event.type !== 'type') {
    return event;
  }
  if (event.element.isPassword !== true) {
    return event;
  }
  return { ...event, text: REDACTED_TEXT };
}

// Imported lazily to avoid pulling the schema into the runtime hot
// path of redaction — the type is enough to satisfy the function
// signature and keeps the type-only re-export from `events.ts` as the
// single declaration site.
import type { RecorderEvent } from './events.js';
import type { AppRef } from './events.js';
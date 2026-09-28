/**
 * services/cua/window-restore.ts — un-minimize a window without stealing
 * focus (plan 578).
 *
 * ZCode-parity primitive for the CUA surface: a screenshot-bearing
 * get_app_state on a minimized window restores it first, so the pixels
 * and the element tree describe one layout. ShowWindow with
 * SW_SHOWNOACTIVATE (4) restores + shows the window WITHOUT activating
 * it — the same precedent computer-use-backend.ts uses for the vision
 * surface ("surface a window without stealing the user's foreground").
 *
 * Deliberately no SW_RESTORE (9) fallback: SW_RESTORE activates the
 * window and yanks the user's focus; when the no-activate restore does
 * not land we report restore_failed instead of silently grabbing input.
 */

import { execFile } from 'node:child_process';

import { getLogger, LogComponent } from '../../logging/logger.js';

const logger = getLogger();

/** ShowWindow nCmdShow: restore + show without activation. */
const SW_SHOWNOACTIVATE = 4;

/** Generous but bounded — a hung restore must not stall the observation. */
const RESTORE_TIMEOUT_MS = 5_000;

/** Run a fixed PowerShell snippet and return its stdout. */
function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: RESTORE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/**
 * Un-minimize one top-level window by its native handle without taking
 * focus. True when ShowWindow reported success. All failures (PowerShell
 * unavailable, refused call, timeout) collapse to false — the caller
 * turns that into a restore_failed receipt, never a throw.
 */
export async function restoreWindowWithoutFocus(windowId: number): Promise<boolean> {
  if (!Number.isInteger(windowId) || windowId <= 0) return false;
  try {
    const stdout = await runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        "$t = Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] " +
        'public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\' ' +
        '-Name Win -Namespace Native -PassThru; ' +
        `$r = $t::ShowWindow([IntPtr]${Number(windowId)}, ${SW_SHOWNOACTIVATE}); ` +
        'if ($r) { "ok" } else { "refused" }',
    );
    return stdout.trim() === 'ok';
  } catch (err) {
    logger.warn(
      'cua: window restore failed',
      { windowId, error: err instanceof Error ? err.message : String(err) },
      LogComponent.ComputerUse,
    );
    return false;
  }
}

/**
 * quit-guard — refuse to throw away running work without asking.
 *
 * Hiding the window is free: the process keeps running. Quitting is not, so
 * it asks first when the Host still has work in flight. The count is local
 * (no Host RPC), which is why nothing here needs a timeout: a count that
 * cannot be read is handled by the caller as "there is nothing running yet"
 * only when the session manager is not up at all.
 *
 * The decision lives here, with no Electron import, so it can be tested as
 * what it is: a mapping from a count to a sentence and from a dialog result
 * to a permission. The dialog itself is in `lifecycle-dialogs.ts`.
 */

const QUIT_BUTTON = 0;

/** Human summary of in-flight work, or null when there is none. */
export function describeBusyWork(streamingSessions: number): string | null {
  if (!Number.isFinite(streamingSessions) || streamingSessions <= 0) return null;
  return streamingSessions === 1
    ? '1 agent run is still streaming.'
    : `${streamingSessions} agent runs are still streaming.`;
}

/**
 * Map the dialog result to "may we quit".
 *
 * Anything other than an explicit affirmative keeps the app alive.
 */
export function resolveBusyQuitChoice(response: number): boolean {
  return response === QUIT_BUTTON;
}

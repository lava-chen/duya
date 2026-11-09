/**
 * lifecycle-dialogs — the two modal questions duya asks about its own life.
 *
 * Both are asynchronous on purpose. The sync variant of `showMessageBox`
 * cannot report a checkbox, and the first-close notice needs one ("don't show
 * this again"); the close event is already prevented while we ask, so there
 * is nothing to gain from blocking the main process for either question.
 *
 * The decisions themselves live in `close-to-hide-notice.ts` and
 * `quit-guard.ts`; this module only owns the window, the wording and the
 * button order.
 */

import { dialog, type BrowserWindow } from 'electron';
import { CLOSE_HIDE_BUTTON, resolveCloseChoice, type CloseChoice } from './close-to-hide-notice';
import { describeBusyWork, resolveBusyQuitChoice } from './quit-guard';

function withParent(parent: BrowserWindow | null) {
  return parent && !parent.isDestroyed() ? parent : null;
}

/** Ask what closing the window should mean. */
export async function promptCloseChoice(parent: BrowserWindow | null): Promise<CloseChoice> {
  const options = {
    type: 'info' as const,
    buttons: ['Hide to tray', 'Quit'],
    defaultId: CLOSE_HIDE_BUTTON,
    cancelId: CLOSE_HIDE_BUTTON,
    title: 'duya is still running',
    message: 'Closing this window hides it to the system tray.',
    detail:
      'Agent runs, background commands and scheduled tasks keep running. '
      + 'Open duya again from the tray icon, or choose Quit to stop everything.',
    checkboxLabel: "Don't show this again",
    checkboxChecked: false,
    noLink: true,
  };
  const owner = withParent(parent);
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return resolveCloseChoice(result.response, result.checkboxChecked);
}

/** Ask whether to quit with work in flight. Returns true when quitting may proceed. */
export async function promptQuitWhileBusy(
  parent: BrowserWindow | null,
  streamingSessions: number,
): Promise<boolean> {
  const summary = describeBusyWork(streamingSessions);
  if (!summary) return true;
  const options = {
    type: 'warning' as const,
    buttons: ['Quit anyway', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Quit duya?',
    message: summary,
    detail:
      'Quitting stops these runs and drops any queued messages. '
      + 'Hiding the window keeps them going.',
    noLink: true,
  };
  const owner = withParent(parent);
  const { response } = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return resolveBusyQuitChoice(response);
}

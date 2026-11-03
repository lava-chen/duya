/**
 * close-to-hide notice — what the first close of the main window means.
 *
 * Closing the window does not exit duya: it hides to the tray and every agent
 * run keeps going. That is surprising the first time, so the first close asks
 * instead of just hiding, and the answer is remembered with the window state.
 *
 * The decision lives here, with no Electron import, so it can be tested as
 * what it is: a mapping from a dialog result to an intent. The dialog itself
 * is in `lifecycle-dialogs.ts`.
 */

/** What the user asked for when the window was closed. */
export type CloseChoiceAction = 'hide' | 'quit';

export interface CloseChoice {
  action: CloseChoiceAction;
  /** True when the user ticked "don't show this again". */
  acknowledge: boolean;
}

/** Button order in the dialog; the indices decide the outcome. */
export const CLOSE_HIDE_BUTTON = 0;
export const CLOSE_QUIT_BUTTON = 1;

/**
 * Map a dialog result to an intent.
 *
 * Every unexpected response hides rather than quits: dismissing the dialog
 * (Esc) must never destroy running work.
 */
export function resolveCloseChoice(response: number, acknowledge: boolean): CloseChoice {
  return {
    action: response === CLOSE_QUIT_BUTTON ? 'quit' : 'hide',
    acknowledge,
  };
}

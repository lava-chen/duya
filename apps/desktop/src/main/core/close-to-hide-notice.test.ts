/**
 * The first close of the main window asks before it hides.
 *
 * What is worth pinning is the mapping, not the dialog: every path that is
 * not an explicit "Quit" must hide, because hiding is reversible and quitting
 * is not.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSE_HIDE_BUTTON,
  CLOSE_QUIT_BUTTON,
  resolveCloseChoice,
} from './close-to-hide-notice';

describe('resolveCloseChoice', () => {
  it('hides when the user picks the default action', () => {
    expect(resolveCloseChoice(CLOSE_HIDE_BUTTON, false)).toEqual({
      action: 'hide',
      acknowledge: false,
    });
  });

  it('quits only on the explicit quit button', () => {
    expect(resolveCloseChoice(CLOSE_QUIT_BUTTON, false)).toEqual({
      action: 'quit',
      acknowledge: false,
    });
  });

  it('treats an unknown response as a hide', () => {
    // Esc, a closed dialog, or a platform-specific extra button all land
    // here. Destroying running work is not an acceptable default.
    expect(resolveCloseChoice(-1, false).action).toBe('hide');
    expect(resolveCloseChoice(99, false).action).toBe('hide');
  });

  it('carries the checkbox through unchanged', () => {
    expect(resolveCloseChoice(CLOSE_HIDE_BUTTON, true).acknowledge).toBe(true);
    expect(resolveCloseChoice(CLOSE_QUIT_BUTTON, true)).toEqual({
      action: 'quit',
      acknowledge: true,
    });
  });
});

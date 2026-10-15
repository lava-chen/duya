/**
 * The inline switch.
 *
 * Small, and worth its own file: it is the only thing standing between a user
 * and a screen model whose scrollback geometry has never met a real terminal, so
 * "does the switch actually reach the app" needs to be answerable without
 * launching one.
 */

import { describe, expect, it } from 'vitest';

import { inlineTuiRequested } from '../chat.js';

describe('inline TUI switch', () => {
  it('is off unless asked for', () => {
    expect(inlineTuiRequested({})).toBe(false);
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: '' })).toBe(false);
  });

  it('turns on for any affirmative value', () => {
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: '1' })).toBe(true);
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: 'true' })).toBe(true);
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: 'yes' })).toBe(true);
  });

  it('honours an explicit off, so a global export can be undone per run', () => {
    // `DUYA_TUI_INLINE=0` has to mean off. Anything else and a shell that
    // exports the variable for one session cannot escape it.
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: '0' })).toBe(false);
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: 'false' })).toBe(false);
    expect(inlineTuiRequested({ DUYA_TUI_INLINE: 'FALSE' })).toBe(false);
  });
});

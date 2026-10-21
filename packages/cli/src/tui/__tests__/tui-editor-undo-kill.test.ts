import { describe, it, expect } from 'vitest';
import { InputEditor, PASTE_PLACEHOLDER_THRESHOLD, pastePlaceholder } from '../editor.js';

/**
 * Undo + kill ring, ported from minimax-code's editor. The semantics under
 * test are the ones an Emacs user's fingers already know, so the tests are
 * named for the behaviour rather than the method: undo steps back one
 * mutation, consecutive kills accumulate, yank-pop cycles.
 */

describe('InputEditor undo', () => {
  it('undoes an insert back to the empty buffer', () => {
    const e = new InputEditor();
    e.insert('hello');
    e.undo();
    expect(e.text).toBe('');
    expect(e.cursor).toBe(0);
  });

  it('undoes step by step through several mutations', () => {
    const e = new InputEditor();
    e.insert('alpha ');
    e.insert('beta');
    e.backspace();
    expect(e.text).toBe('alpha bet');
    e.undo(); // back the backspace out
    expect(e.text).toBe('alpha beta');
    e.undo(); // back the 'beta' insert out
    expect(e.text).toBe('alpha ');
    e.undo();
    expect(e.text).toBe('');
    e.undo(); // undo past the beginning is a no-op
    expect(e.text).toBe('');
  });

  it('undoes a kill to its pre-kill text', () => {
    const e = new InputEditor();
    e.setText('alpha beta', 6); // caret before 'beta'
    e.killToEnd();
    expect(e.text).toBe('alpha ');
    e.undo();
    expect(e.text).toBe('alpha beta');
  });

  it('undoes a history recall and then the submit that cleared the draft', () => {
    const e = new InputEditor();
    e.insert('draft in progress');
    e.submitIfPresent(); // buffer now empty; the draft is in history
    e.setText('recalled', 8);
    // Undo #1 backs out the recall (snapshot: the empty pre-recall buffer)...
    e.undo();
    expect(e.text).toBe('');
    // ...undo #2 backs out the submit's clear, restoring the draft.
    e.undo();
    expect(e.text).toBe('draft in progress');
  });

  it('undoes a collapsed paste including its placeholder map entry', () => {
    const e = new InputEditor();
    const big = 'x'.repeat(PASTE_PLACEHOLDER_THRESHOLD + 1);
    e.insert(big);
    expect(e.hasCollapsedPaste).toBe(true);
    e.undo();
    expect(e.text).toBe('');
    expect(e.hasCollapsedPaste).toBe(false);
  });

  it('keeps an undo of one paste from orphaning a second one', () => {
    const e = new InputEditor();
    const big = (ch: string) => ch.repeat(PASTE_PLACEHOLDER_THRESHOLD + 1);
    e.insert(big('x'));
    e.insert(' ');
    e.insert(big('y'));
    expect(e.hasCollapsedPaste).toBe(true);
    // One backspace breaks marker #2's label; marker #1 must survive.
    e.backspace();
    expect(e.text).not.toContain(pastePlaceholder(big('y'), 2));
    expect(e.hasCollapsedPaste).toBe(true);
    e.undo(); // the pre-backspace snapshot restores the intact pair
    expect(e.text).toContain(pastePlaceholder(big('x'), 1));
    expect(e.text).toContain(pastePlaceholder(big('y'), 2));
  });
});

describe('InputEditor kill ring', () => {
  it('yanks back the last kill', () => {
    const e = new InputEditor();
    e.insert('alpha beta');
    e.moveEnd();
    e.killWordBackward();
    expect(e.text).toBe('alpha ');
    e.yank();
    expect(e.text).toBe('alpha beta');
  });

  it('accumulates consecutive kills into one entry', () => {
    const e = new InputEditor();
    e.setText('alpha beta gamma', 11); // caret between 'beta ' and 'gamma'
    e.killToEnd(); // forward kill of 'gamma'
    e.killWordBackward(); // backward kill of 'beta ' — consecutive
    e.yank();
    // The ring entry accumulated in DOCUMENT order ('beta gamma' — the
    // backward kill was prepended onto the forward one), and one yank
    // restores both into the remaining buffer.
    expect(e.text).toBe('alpha beta gamma');
  });

  it('breaks accumulation when the user types between kills', () => {
    const e = new InputEditor();
    e.insert('alpha beta');
    e.moveEnd();
    e.killWordBackward(); // kills 'beta'
    e.insert('delta');
    e.killWordBackward(); // kills 'delta' — NOT accumulated with 'beta'
    e.yank();
    // The ring top is the NEWEST kill, so the first yank is 'delta'.
    expect(e.text).toBe('alpha delta');
    e.undo();
    e.yank();
    expect(e.text).toBe('alpha delta');
    // Cycling past the newest kill reaches the earlier one.
    e.yankPop();
    expect(e.text).toBe('alpha beta');
  });

  it('prepends backward kills so accumulated text reads in order', () => {
    const e = new InputEditor();
    e.insert('one two three');
    e.moveEnd();
    e.killWordBackward(); // 'three'
    e.killWordBackward(); // 'two' — earlier in the buffer
    e.yank();
    expect(e.text).toBe('one two three');
  });

  it('yank-pop cycles to the older kill only right after a yank', () => {
    const e = new InputEditor();
    e.insert('first');
    e.moveEnd();
    e.killToStart(); // ring: ['first']
    e.insert('second'); // typing breaks kill accumulation
    e.moveEnd();
    e.killToStart(); // ring: ['first', 'second']
    e.yank();
    expect(e.text).toBe('second');
    e.yankPop();
    expect(e.text).toBe('first');
    e.yankPop(); // cycles back around the ring
    expect(e.text).toBe('second');
  });

  it('refuses yank-pop after the user typed', () => {
    const e = new InputEditor();
    e.insert('first');
    e.moveEnd();
    e.killToStart(); // ring: ['first']
    e.insert('second');
    e.moveEnd();
    e.killToStart(); // ring: ['first', 'second']
    e.yank();
    e.insert('x'); // typing invalidates the yank state
    e.yankPop(); // must be a no-op
    expect(e.text).toBe('secondx');
  });

  it('yank is undoable', () => {
    const e = new InputEditor();
    e.insert('keep');
    e.moveEnd();
    e.killToStart();
    e.yank();
    expect(e.text).toBe('keep');
    e.undo();
    expect(e.text).toBe('');
  });

  it('killing a collapsed paste puts its EXPANDED content on the ring', () => {
    const e = new InputEditor();
    const big = 'y'.repeat(PASTE_PLACEHOLDER_THRESHOLD + 1);
    e.insert(big);
    e.moveEnd();
    e.killToStart();
    expect(e.text).toBe('');
    e.yank();
    // The yank goes through the ordinary insert path: huge content collapses
    // to a fresh placeholder, the layout never holds the payload, and submit
    // still delivers the real content.
    expect(e.hasCollapsedPaste).toBe(true);
    expect(e.text.length).toBeLessThan(60);
    expect(e.submit()).toBe(big);
  });
});

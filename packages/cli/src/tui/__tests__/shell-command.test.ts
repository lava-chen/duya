/**
 * The `!` prefix rule.
 *
 * The composer and the submit path read the same rule, so a draft that the
 * composer paints as a command is always a command that runs. These tests pin
 * the rule itself: which drafts open with a bang, what the prompt column
 * holds, and how much of the draft the prompt covers.
 */

import { describe, expect, it } from 'vitest';
import { shellDraftOf } from '../shell-command.js';

describe('shellDraftOf', () => {
  it('recognises a command draft and keeps the command', () => {
    const draft = shellDraftOf('!git status');
    expect(draft?.prefix).toBe('!');
    expect(draft?.command).toBe('git status');
    expect(draft?.body).toBe('git status');
  });

  it('keeps the opt-out marker in the prompt column', () => {
    const draft = shellDraftOf('!!git status');
    expect(draft?.prefix).toBe('!!');
    expect(draft?.glyph).toBe('!!');
    expect(draft?.command).toBe('git status');
  });

  it('draws both forms in the same two columns', () => {
    // The text after the prompt starts in the same column whichever prefix
    // the draft opens with, so the body never shifts under the user.
    expect(shellDraftOf('!a')?.prompt).toBe('! ');
    expect(shellDraftOf('!!a')?.prompt).toBe('!!');
  });

  it('finds the bang after leading blanks, because the submit path trims first', () => {
    const draft = shellDraftOf('  !ls');
    expect(draft?.command).toBe('ls');
    // The blanks are covered by the prompt too: the caret shifts left by all
    // of them, not only by the bang.
    expect(draft?.stripped).toBe(3);
  });

  it('counts code points, so the body keeps its own text intact', () => {
    const draft = shellDraftOf('!🙂x');
    expect(draft?.command).toBe('🙂x');
    expect(draft?.stripped).toBe(1);
  });

  it('leaves an ordinary message alone', () => {
    expect(shellDraftOf('hello')).toBeNull();
    expect(shellDraftOf('')).toBeNull();
    expect(shellDraftOf('   ')).toBeNull();
    // A bang that is not at the front is part of the message.
    expect(shellDraftOf('hello !ls')).toBeNull();
  });
});

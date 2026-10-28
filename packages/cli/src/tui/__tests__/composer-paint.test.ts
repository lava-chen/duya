/**
 * The composer's shell prompt.
 *
 * The prompt is the one thing a reader must never miss: it is the difference
 * between "this goes to the model" and "this runs on my machine". These tests
 * pin the paint, not the layout — the layout's own tests cover where the
 * prompt sits and how much of the draft it covers.
 */

import { describe, expect, it } from 'vitest';
import { buildComposerLayout } from '../composer-layout.js';
import { NO_SHELL_PROMPT, paintComposerRow } from '../composer-paint.js';
import { shellDraftOf } from '../shell-command.js';

const ERROR_TAG = 'bright-red-fg';

/** Drop blessed tags, leaving the text a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

describe('paintComposerRow', () => {
  it('tints the bang in the error colour', () => {
    const painted = paintComposerRow('! ls -la', 0, {
      errorTag: ERROR_TAG,
      shellPrompt: { row: 0, glyph: '!' },
    });
    expect(painted).toBe('{bright-red-fg}!{/bright-red-fg} ls -la');
  });

  it('tints the opt-out marker whole', () => {
    const painted = paintComposerRow('!!git status', 0, {
      errorTag: ERROR_TAG,
      shellPrompt: { row: 0, glyph: '!!' },
    });
    expect(painted).toBe('{bright-red-fg}!!{/bright-red-fg}git status');
  });

  it('leaves an ordinary prompt alone', () => {
    const painted = paintComposerRow('❯ hello', 0, {
      errorTag: ERROR_TAG,
      shellPrompt: NO_SHELL_PROMPT,
    });
    expect(painted).toBe('❯ hello');
  });

  it('tints nothing when the prompt row scrolled out of view', () => {
    // The draft scrolled: the row starts with the continuation indent, so
    // there is no prompt column to tint.
    const painted = paintComposerRow('  ls -la', 0, {
      errorTag: ERROR_TAG,
      shellPrompt: { row: 0, glyph: '!' },
    });
    expect(painted).toBe('  ls -la');
  });

  it('escapes the text it paints', () => {
    const painted = paintComposerRow('❯ {a}', 0, {
      errorTag: ERROR_TAG,
      shellPrompt: NO_SHELL_PROMPT,
    });
    expect(painted).toBe('❯ {open}a}');
  });

  it('paints the row the composer shows for a command draft', () => {
    // The two halves the composer runs in sequence: the layout puts the bang
    // in the prompt column, and the painter tints it. Inline mode paints the
    // rules and the body together, so the prompt row is the one under the
    // top rule.
    const draft = shellDraftOf('!ls -la');
    const layout = buildComposerLayout('!ls -la', 7, {
      columns: 20,
      terminalRows: 16,
      shellPrefix: draft ?? undefined,
    });
    const painted = paintComposerRow(layout.lines[1] ?? '', 1, {
      errorTag: ERROR_TAG,
      shellPrompt: { row: 1, glyph: draft?.glyph ?? '' },
    });

    expect(strip(painted)).toBe('! ls -la');
    expect(painted).toBe('{bright-red-fg}!{/bright-red-fg} ls -la');
  });
});

import { describe, expect, it } from 'vitest';
import type { PopoverItem } from '@duya/input-completion';
import { CompletionController } from '../completion.js';

/**
 * Two rules the popup lives or dies by, both driven the way a user drives them.
 *
 * ## Ranking
 *
 * The popup's FIRST row is the one Enter acts on, so "the row the user meant"
 * has to be "the row on top" — a filter that keeps source order leaves the
 * command they were typing somewhere below commands they were not, and Enter
 * then runs the wrong one.
 *
 * ## Enter
 *
 * One Enter on a command row must RUN it. Completing the text and waiting for
 * a second Enter is the behaviour that reads as a broken key. `Tab` stays the
 * insert-only counterpart, and Enter inside a sentence stays an insertion,
 * because there it is completing a word rather than choosing a command.
 */

function item(label: string, description = ''): PopoverItem {
  return {
    label,
    value: label,
    description,
    kind: 'slash_command',
    category: 'command',
    group: 'settings',
  };
}

/** `/sessions` is second on purpose: the winner must not already be first. */
const COMMANDS = [
  item('/settings', 'Configure the terminal'),
  item('/sessions', 'Browse previous sessions'),
  item('/status', 'Show token usage'),
  item('/model', 'Switch the model'),
];

function makeController(over: { slash?: PopoverItem[]; context?: PopoverItem[] } = {}) {
  return new CompletionController({
    slash: () => over.slash ?? COMMANDS,
    context: () => over.context ?? [],
    files: () => [],
  });
}

describe('CompletionController — ranking', () => {
  it('puts the closest command on top, wherever it sits in the source', () => {
    const c = makeController();
    const state = c.update('/ses', 4);
    expect(state.items.map((i) => i.value)).toEqual(['/sessions', '/settings']);
  });

  it('leaves the source order alone before anything is typed', () => {
    // An unfiltered list has a real order — the catalog's — and replacing it
    // with a score would reorder commands the user has not narrowed yet.
    const c = makeController();
    expect(c.update('/', 1).items.map((i) => i.value)).toEqual([
      '/settings',
      '/sessions',
      '/status',
      '/model',
    ]);
  });

  it('still finds a command by its description', () => {
    const c = makeController();
    expect(c.update('/browse', 7).items.map((i) => i.value)).toEqual(['/sessions']);
  });

  it('ranks the rows an argument popup offers, for the same reason', () => {
    const c = new CompletionController({
      slash: () => COMMANDS,
      context: () => [],
      files: () => [],
      slashOptions: () => [item('alpha', ''), item('alphabet', ''), item('beta', '')],
    });
    // 'bet' is a prefix of `beta` and a scattered hit in `alphabet`, so it
    // leads a list it was LAST in.
    expect(c.update('/resume bet', 11).items.map((i) => i.value)).toEqual(['beta', 'alphabet']);
  });

  it('does NOT reorder context rows, which stay in the source order', () => {
    // Deliberate asymmetry: `@` offers a handful of attachments and modes, and
    // a stable list the user can learn beats one that reshuffles per keystroke.
    const c = makeController({ context: [item('@beta', ''), item('@alpha', '')] });
    expect(c.update('@', 1).items.map((i) => i.value)).toEqual(['@beta', '@alpha']);
  });
});

describe('CompletionController — Enter runs a command', () => {
  it('accepts AND submits when the command is the whole line', () => {
    const c = makeController();
    c.update('/mod', 4);
    const result = c.handleKey('return', '/mod');
    expect(result.consumed).toBe(true);
    expect(result.accepted?.text).toBe('/model ');
    expect(result.submitAfterAccept).toBe(true);
  });

  it('runs the row it put on top, not the row the user happened to type past', () => {
    const c = makeController();
    c.update('/ses', 4);
    expect(c.handleKey('return', '/ses').accepted?.text).toBe('/sessions ');
  });

  it('only INSERTS inside a sentence, so Enter never sends a half-written prompt', () => {
    const c = makeController();
    const text = 'please run /mod';
    c.update(text, text.length);
    const result = c.handleKey('return', text);
    expect(result.accepted?.text).toBe('please run /model ');
    expect(result.submitAfterAccept).toBeUndefined();
  });

  it('only INSERTS when text follows the command on the same line', () => {
    const c = makeController();
    // Caret after `/mod`, with ` now` already typed behind it.
    c.update('/mod now', 4);
    const result = c.handleKey('return', '/mod now');
    // No double space: `after` already starts with one.
    expect(result.accepted?.text).toBe('/model now');
    expect(result.submitAfterAccept).toBeUndefined();
  });

  it('leaves Tab as the insert-only key, so an argument can still be typed', () => {
    const c = makeController();
    c.update('/mod', 4);
    const result = c.handleKey('tab', '/mod');
    expect(result.accepted?.text).toBe('/model ');
    expect(result.submitAfterAccept).toBeUndefined();
  });

  it('still submits after an argument row is chosen', () => {
    const c = new CompletionController({
      slash: () => COMMANDS,
      context: () => [],
      files: () => [],
      slashOptions: () => [item('abc123', '')],
    });
    c.update('/resume ab', 10);
    const result = c.handleKey('return', '/resume ab');
    expect(result.accepted?.text).toBe('/resume abc123');
    expect(result.submitAfterAccept).toBe(true);
  });

  it('releases Enter when the popup is closed, so a plain prompt still sends', () => {
    const c = makeController();
    expect(c.handleKey('return', 'hello').consumed).toBe(false);
  });
});

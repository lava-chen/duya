import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import type { PopoverItem } from '@duya/input-completion';
import { TUIApp } from '../TUIApp.js';

/**
 * The popup inside the real blessed shell.
 *
 * ## Why this file exists separately from the state machine's own tests
 *
 * `tui-completion.test.ts` proves the RULES. This proves the WIRING, which is
 * where the failure the user would actually see lives: a correct controller
 * behind bindings that lose the race renders rows that no key can reach.
 *
 * The specific bug this shape is aimed at — every one of `up`, `down`, `tab`,
 * `return` and `escape` is ALSO bound to something else in this file (input
 * history, a two-space indent, submit, overlay dismissal). A controller test
 * passes no matter how that ordering comes out; only real bytes through the real
 * key path can see it.
 */

function sink(): { stream: Writable; text: () => string; reset: () => void } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString('utf8'),
    reset: () => {
      chunks.length = 0;
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Gap between keystrokes that reads as human typing rather than one paste.
 * Comfortably past the detector's 8 ms burst window.
 */
const TYPING_INTERVAL_MS = 20;

async function type(input: PassThrough, text: string): Promise<void> {
  for (const ch of text) {
    input.write(ch);
    await new Promise((resolve) => setTimeout(resolve, TYPING_INTERVAL_MS));
  }
}

function item(label: string, value: string, description = ''): PopoverItem {
  return { label, value, description };
}

const SLASH: PopoverItem[] = [
  item('/doctor', '/doctor', 'Diagnose'),
  item('/review', '/review', 'Review'),
];

const EFFORT_OPTIONS: PopoverItem[] = ['none', 'minimal', 'low', 'medium', 'high', 'show', 'hide']
  .map((value) => item(value, value));
const MODEL_OPTIONS: PopoverItem[] = [
  item('MiniMax-M3', 'MiniMax-M3', 'current'),
  item('MiniMax-M2.7', 'MiniMax-M2.7'),
];

function makeApp(submitted: string[] = [], withEffortOptions = false, withModelOptions = false) {
  const out = sink();
  const input = new PassThrough();
  const app = new TUIApp({
    output: out.stream,
    input,
    completionSources: {
      slash: () => [
        ...(withEffortOptions ? [item('/effort', '/effort', 'Reasoning effort')] : []),
        ...(withModelOptions ? [item('/model', '/model', 'Switch model')] : []),
        ...(!withEffortOptions && !withModelOptions ? SLASH : []),
      ],
      slashOptions: (command) => command === '/effort' ? EFFORT_OPTIONS : command === '/model' ? MODEL_OPTIONS : [],
      slashOptionsOnBare: (command) => command === '/model',
      context: () => [],
      files: () => [],
    },
    onSubmit: (text) => {
      submitted.push(text);
    },
  });
  return { app, out, input };
}

describe('TUIApp completion popup', () => {
  it('renders rows when a slash is typed', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();

    input.write('/');
    await settle();

    expect(out.text()).toContain('/doctor');
    expect(out.text()).toContain('/review');
    app.stop();
  });

  it('does not render rows before a trigger is typed', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();
    out.reset();

    input.write('h');
    await settle();

    expect(out.text()).not.toContain('/doctor');
    app.stop();
  });

  it('navigates with the arrow keys instead of scrolling input history', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();
    input.write('/');
    await settle();
    out.reset();

    input.write('\x1b[B'); // down
    await settle();
    // Tab, not Enter: Enter RUNS the row it accepted (see the next test), so
    // only Tab can show which row the arrow landed on.
    input.write('\t');
    await settle();

    // If the arrow had reached the editor it would have recalled history; if
    // Tab had reached the input line it would have inserted two spaces.
    expect(app.inputText).toBe('/review ');
    app.stop();
  });

  it('runs the accepted command on ONE Enter, and never submits what was typed', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    input.write('/rev');
    await settle();
    input.write('\r');
    await settle();

    // Two failures this pins, one on each side of the same key:
    //  - the half-typed `/rev` must never reach the prompt;
    //  - the accepted `/review ` must RUN, because a completion that leaves the
    //    command in the editor costs the user a second Enter for no reason.
    // Trimmed on the way out: the trailing space the accept added is not part
    // of the command the loop dispatches.
    expect(submitted).toEqual(['/review']);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('leaves Enter as an insertion when the command is part of a longer line', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    await type(input, 'please run /rev');
    input.write('\r');
    await settle();

    // Here the popup is completing a WORD, not choosing a command, so Enter
    // must not send the sentence as a prompt.
    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('please run /review ');
    app.stop();
  });

  it('submits on Enter when the popup is closed', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    // Typed at human speed deliberately. A single `write('hello')` is
    // indistinguishable from a paste, and a pasted Enter is content rather than
    // a submission — which is correct, and is what the next test pins.
    await type(input, 'hello');
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['hello']);
    app.stop();
  });

  it('treats an Enter that ends a paste as a newline, not a submission', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    // The shape a terminal really delivers a paste in: one burst, then Enter.
    // Without this, pasting a multi-line snippet would start one agent run per
    // line — the exact harm `PasteBurstDetector` exists to prevent, and the one
    // thing its own unit tests cannot see, since they stop at the detector.
    input.write('hello');
    await settle();
    input.write('\r');
    await settle();

    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('hello\n');
    app.stop();
  });

  it('closes on Escape without inserting, and leaves the text alone', async () => {
    const submitted: string[] = [];
    const { app, out, input } = makeApp(submitted);
    app.start();
    await settle();
    input.write('/');
    await settle();
    out.reset();

    input.write('\x1b'); // escape
    await settle();

    expect(out.text()).not.toContain('/doctor');
    expect(app.inputText).toBe('/');
    app.stop();
  });

  it('accepts on Tab rather than inserting two spaces', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    input.write('/rev');
    await settle();
    input.write('\t');
    await settle();

    expect(app.inputText).toBe('/review ');
    app.stop();
  });

  it('re-filters as the user types more of the trigger', async () => {
    const { app, out, input } = makeApp();
    app.start();
    await settle();
    input.write('/');
    await settle();
    out.reset();

    input.write('rev');
    await settle();

    expect(out.text()).toContain('/review');
    // The deselected row is gone from the list, not merely unhighlighted.
    expect(out.text()).not.toContain('/doctor');
    app.stop();
  });

  it('opens a second-level option menu and runs the selected slash option', async () => {
    const submitted: string[] = [];
    const { app, out, input } = makeApp(submitted, true);
    app.start();
    await settle();

    // Tab opens the second level: Enter on a bare command now RUNS it, which
    // is the point, but this test is about the menu behind the space.
    await type(input, '/effort');
    input.write('\t');
    await settle();

    expect(app.inputText).toBe('/effort ');
    expect(out.text()).toContain('minimal');

    input.write('\x1b[B'); // choose the second option
    await settle();
    input.write('\r'); // select and run it
    await settle();

    expect(submitted).toEqual(['/effort minimal']);
    app.stop();
  });

  it('lets Tab fill a slash option without running it', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted, true);
    app.start();
    await settle();

    await type(input, '/effort ');
    input.write('\t');
    await settle();

    expect(app.inputText).toBe('/effort none');
    expect(submitted).toEqual([]);
    app.stop();
  });

  it('does not turn a slash command mentioned in a prompt into a command menu', async () => {
    const { app, out, input } = makeApp([], true);
    app.start();
    await settle();

    await type(input, 'Use /effort ');

    expect(app.inputText).toBe('Use /effort ');
    expect(out.text()).not.toContain('minimal');
    app.stop();
  });

  it('opens the model picker as soon as the bare command is typed and submits the chosen model', async () => {
    const submitted: string[] = [];
    const { app, out, input } = makeApp(submitted, false, true);
    app.start();
    await settle();

    await type(input, '/model');
    await settle();

    expect(out.text()).toContain('MiniMax-M3');
    expect(out.text()).toContain('MiniMax-M2.7');
    input.write('\x1b[B');
    await settle();
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['/model MiniMax-M2.7']);
    app.stop();
  });
});

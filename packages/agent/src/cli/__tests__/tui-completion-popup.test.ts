import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import type { PopoverItem } from '@duya/input-completion';
import { TUIApp } from '../ui/TUIApp.js';

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

function makeApp(submitted: string[] = []) {
  const out = sink();
  const input = new PassThrough();
  const app = new TUIApp({
    output: out.stream,
    input,
    completionSources: { slash: () => SLASH, context: () => [], files: () => [] },
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
    input.write('\r'); // accept the SECOND row
    await settle();

    // If the arrow had reached the editor it would have recalled history; if
    // Enter had reached the prompt it would have submitted `/`.
    expect(app.inputText).toBe('/review ');
    app.stop();
  });

  it('accepts on Enter without submitting the raw text', async () => {
    const submitted: string[] = [];
    const { app, input } = makeApp(submitted);
    app.start();
    await settle();

    input.write('/rev');
    await settle();
    input.write('\r');
    await settle();

    // The completion was accepted into the buffer, so Enter did NOT submit.
    // Submitting here is the bug: the user would get a run for `/rev`.
    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('/review ');
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
});
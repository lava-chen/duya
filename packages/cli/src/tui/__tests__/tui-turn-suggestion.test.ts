/**
 * The predicted next prompt in the TUI composer.
 *
 * The worker predicts the prompt the user is most likely to send next and the
 * chat loop draws it in the composer's placeholder. The suggestion is a hint
 * until the user takes it: it has to land in the composer as ordinary text the
 * user can read, edit and then send — a grey line nobody can put their hands
 * on is not a suggestion the user can act on.
 *
 * These tests drive real bytes for the same reason the routing suites do: the
 * question is not "did the handler run" but "does the keystroke the user
 * pressed reach the behaviour".
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';
import { press } from './key-injection.js';

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
  await settle();
}

/**
 * Wait out the lone-Escape timeout.
 *
 * A bare `\x1b` is ambiguous until the parser knows no sequence follows, so it
 * holds the byte for 35 ms.
 */
async function settleEscape(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
}

const TYPING_INTERVAL_MS = 20;

async function type(input: PassThrough, text: string): Promise<void> {
  for (const ch of text) {
    input.write(ch);
    await new Promise((resolve) => setTimeout(resolve, TYPING_INTERVAL_MS));
  }
}

function makeApp(suggestion: string | null) {
  const out = sink();
  const input = new PassThrough();
  const submitted: string[] = [];
  const app = new TUIApp({
    output: out.stream,
    input,
    echoSubmitted: false,
    turnSuggestion: () => suggestion,
    onSubmit: (text) => { submitted.push(text); },
  });
  app.start();
  return { app, input, out, submitted };
}

describe('TUIApp turn suggestion', () => {
  it('puts the suggestion in the composer when Enter arrives on an empty input', async () => {
    const { app, input, submitted } = makeApp('now run the failing test');
    await settle();

    press(input, 'return');
    await settle();

    // Nothing is sent: the suggestion is taken, not run. The text lands in the
    // composer where the user can read it and edit it.
    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('now run the failing test');
    app.stop();
  });

  it('sends the adopted suggestion on the next Enter', async () => {
    const { app, input, submitted } = makeApp('now run the failing test');
    await settle();

    press(input, 'return');
    await settle();
    press(input, 'return');
    await settle();

    expect(submitted).toEqual(['now run the failing test']);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('sends what the user typed instead of the suggestion', async () => {
    const { app, input, submitted } = makeApp('now run the failing test');
    await settle();

    await type(input, 'something else');
    press(input, 'return');
    await settle();

    expect(submitted).toEqual(['something else']);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('leaves Enter inert when there is no suggestion to take', async () => {
    const { app, input, submitted } = makeApp(null);
    await settle();

    press(input, 'return');
    await settle();

    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('still takes the suggestion on Esc', async () => {
    const { app, input, submitted } = makeApp('now run the failing test');
    await settle();

    press(input, 'escape');
    await settleEscape();

    expect(submitted).toEqual([]);
    expect(app.inputText).toBe('now run the failing test');
    app.stop();
  });

  it('advertises the key in the status line while the suggestion waits', async () => {
    const { app, out } = makeApp('now run the failing test');
    await settleRendered();

    expect(out.text()).toContain('Enter adopt');
    app.stop();
  });
});

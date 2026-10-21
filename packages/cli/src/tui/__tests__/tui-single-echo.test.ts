/**
 * A submitted prompt appears exactly once.
 *
 * Every prompt used to be appended twice: `TUIApp.submit` echoes the line the
 * instant Enter is pressed, and `runTurn` echoed it again when the turn
 * started. A full-screen window scrolled past the second copy before anyone
 * looked at it, so the bug survived; the inline model puts the two copies side
 * by side, which is how it was finally seen.
 *
 * ## What this can and cannot catch
 *
 * It drives the real submit path — keystrokes in, Enter, count — so it fails if
 * an echo is added inside `submit`. It cannot cover the second owner: `runTurn`
 * lives in `chat.ts` behind an ephemeral Host, and the line that echoed twice
 * has been deleted rather than mocked. An earlier version of this file called
 * `printUser` directly and passed even with the duplicate reinstated, which is
 * why it asserts through the path a prompt actually takes.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';

import { TUIApp } from '../TUIApp.js';

function makeApp(submitted: string[] = []) {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const input = new PassThrough();
  const app = new TUIApp({
    output: stream,
    input,
    onSubmit: (text) => {
      submitted.push(text);
    },
  });
  return { app, submitted, input, rendered: () => Buffer.concat(chunks).toString('utf8') };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Type into the composer through stdin.
 *
 * Bytes in, not synthetic `key` events: blessed's key names are not the
 * characters a terminal sends, and a test that emits `'key h'` instead of
 * writing `h` proves nothing about the path a prompt actually takes.
 */
async function type(app: TUIApp, input: PassThrough, text: string): Promise<void> {
  for (const character of text) {
    input.write(character);
    await sleep(5);
  }
}

async function pressEnter(input: PassThrough): Promise<void> {
  input.write('\r');
  await sleep(20);
}

describe('the submitted prompt', () => {
  it('is recorded once when Enter is pressed', async () => {
    const { app, submitted, input } = makeApp();
    app.start();
    await type(app, input, 'hey');
    await pressEnter(input);
    expect(submitted).toEqual(['hey']);
    expect(app.userEchoCount('hey')).toBe(1);
    app.stop();
  });

  it('records a second, different prompt as a second line', async () => {
    // The guard against the over-eager fix. Collapsing consecutive identical
    // user lines would make this pass while breaking a user who really does
    // send the same thing twice.
    const { app, input } = makeApp();
    app.start();
    await type(app, input, 'hey');
    await pressEnter(input);
    await type(app, input, 'hello');
    await pressEnter(input);
    expect(app.userEchoCount('hey')).toBe(1);
    expect(app.userEchoCount('hello')).toBe(1);
    app.stop();
  });

  it('records an empty submission as nothing at all', async () => {
    const { app, input } = makeApp();
    app.start();
    await pressEnter(input);
    expect(app.userEchoCount('')).toBe(0);
    app.stop();
  });
});

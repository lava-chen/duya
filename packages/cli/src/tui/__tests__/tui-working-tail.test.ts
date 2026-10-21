/**
 * The working tail, wired.
 *
 * `working-tail.test.ts` proves the line is built correctly. This proves the
 * two things that would still be wrong with a perfectly correct line:
 *
 * 1. It is CHROME. A transcript row is committed to the terminal's scrollback
 *    permanently, so a spinner placed there leaves braille in the user's
 *    history forever. Asserted against the actual write stream, not the call
 *    arguments, because the call arguments are the thing being doubted.
 * 2. It only appears while a turn is running, and it disappears again — which
 *    is why it lives in the row-blanking slack rather than as a committed line.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';

import { TUIApp } from '../TUIApp.js';
import { detectTerminalEnvironment } from '../terminal-env.js';
import { SPINNER_UNICODE, WORKING_TAIL_INTERVAL_MS } from '../working-tail.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

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

function makeApp(overrides: { inline?: boolean; busy?: boolean; unicodeBox?: boolean } = {}) {
  const out = sink();
  const busy = { value: overrides.busy ?? false };
  const app = new TUIApp({
    output: out.stream,
    input: new PassThrough(),
    inline: overrides.inline === true,
    // Pinned rather than inherited: with no TERM the detected environment says
    // `unicodeBox: false`, so the braille assertions below would silently be
    // assertions about the ASCII fallback — a test that passes for the wrong
    // reason, which is the thing these assertions exist to prevent.
    terminalEnv: detectTerminalEnvironment({ TERM_PROGRAM: 'WezTerm' }),
    isBusy: () => busy.value,
    onSubmit: () => {},
  });
  if (overrides.unicodeBox === false) {
    (app as unknown as { terminalEnv: { unicodeBox: boolean } }).terminalEnv.unicodeBox = false;
  }
  return { app, out, busy };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleRendered(): Promise<void> {
  await sleep(0);
  await sleep(0);
  await sleep(MIN_RENDER_INTERVAL_MS + 40);
}

/** Bytes written between a scroll-region set and its reset: the commits. */
function commitWrites(text: string): string[] {
  const writes: string[] = [];
  const pattern = /\x1b\[(\d+);(\d+)r([\s\S]*?)\x1b\[r/gu;
  for (const match of text.matchAll(pattern)) writes.push(match[3] ?? '');
  return writes;
}

describe('the working tail', () => {
  it('shows nothing until a turn is running', async () => {
    const { app, out } = makeApp({ inline: true });
    app.start();
    await settleRendered();
    app.stop();
    expect([...out.text()].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(false);
  });

  it('appears while a turn runs', async () => {
    const { app, out } = makeApp({ inline: true, busy: true });
    app.start();
    await settleRendered();
    app.stop();
    expect([...out.text()].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(true);
  });

  it('animates rather than sitting on one glyph', async () => {
    const { app, out } = makeApp({ inline: true, busy: true });
    app.start();
    // Three intervals: enough for the clock to move twice. A single sample
    // cannot tell "animating" from "stuck", which is the failure being ruled out.
    await sleep(WORKING_TAIL_INTERVAL_MS * 3 + 60);
    app.stop();
    const distinct = new Set([...out.text()].filter((ch) => SPINNER_UNICODE.includes(ch)));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it('never reaches the scrollback', async () => {
    const { app, out } = makeApp({ inline: true, busy: true });
    app.start();
    // Enough content to force many commits, so the claim is tested against
    // writes that really happened rather than against a frame that never filled.
    app.push({ type: 'text_delta', data: { content: `${Array.from({ length: 120 }, (_, i) => `filler ${i}`).join('\n')}\n` } });
    await settleRendered();
    await sleep(WORKING_TAIL_INTERVAL_MS * 3 + 60);
    app.stop();

    const commits = commitWrites(out.text());
    expect(commits.length).toBeGreaterThan(0);
    const committedText = commits.join('');
    expect(committedText).toContain('filler 0');
    // The whole point of putting the tail in chrome: a spinner in the
    // scrollback is a line of braille the user cannot delete and did not ask
    // for, sitting where a tool call happened.
    expect([...committedText].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(false);
    // And it is genuinely on screen at the same time, so this is not the tail
    // failing to render being mistaken for the tail being correctly withheld.
    expect([...out.text()].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(true);
  });

  it('appears in the full-screen status line while a turn runs', async () => {
    const { app, out } = makeApp({ busy: true });
    app.start();
    await settleRendered();
    app.stop();
    expect([...out.text()].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(true);
  });
});

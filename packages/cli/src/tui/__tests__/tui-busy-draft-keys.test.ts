import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';
import { press } from './key-injection.js';

/**
 * The three busy-time keys, asserted at the byte level.
 *
 * A run in flight turns the composer into a second channel: Enter steers the
 * running turn, Tab holds the draft for the next one, and Esc stops the run
 * and then sends. Each of those sits on a key that already means something
 * else when idle (Enter submits, Tab indents or recalls history, Esc closes),
 * so the routing is only correct if the busy branch is reached — which is what
 * these tests press the keys to check.
 */

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

const TYPING_INTERVAL_MS = 20;

async function type(input: PassThrough, text: string): Promise<void> {
  for (const ch of text) {
    input.write(ch);
    await new Promise((resolve) => setTimeout(resolve, TYPING_INTERVAL_MS));
  }
}

function makeApp(options: { busy: boolean; recall?: string | null }) {
  const out = sink();
  const input = new PassThrough();
  const calls = {
    submitted: [] as string[],
    steered: [] as string[],
    queued: [] as string[],
    interrupted: 0,
    stopAndSend: [] as string[],
  };
  const app = new TUIApp({
    output: out.stream,
    input,
    echoSubmitted: false,
    isBusy: () => options.busy,
    onSubmit: (text) => { calls.submitted.push(text); },
    onSteer: (text) => { calls.steered.push(text); },
    onQueueDraft: (text) => { calls.queued.push(text); },
    onInterrupt: () => { calls.interrupted += 1; },
    onInterruptAndSend: (text) => { calls.stopAndSend.push(text); },
    onRecallQueued: () => options.recall ?? null,
  });
  app.start();
  return { app, input, out, calls };
}

describe('composer keys while a turn runs', () => {
  it('steers the running turn on Enter instead of starting a new one', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, 'check the tests first');
    press(input, 'return');
    await settle();

    expect(calls.steered).toEqual(['check the tests first']);
    expect(calls.submitted).toEqual([]);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('holds the draft for the next turn on Tab', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, 'later');
    press(input, 'tab');
    await settle();

    expect(calls.queued).toEqual(['later']);
    expect(calls.steered).toEqual([]);
    expect(calls.submitted).toEqual([]);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('keeps Tab on focus switching when the composer is empty', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    press(input, 'tab');
    await settle();

    expect(calls.queued).toEqual([]);
    // The focus layer is the task view, not the transcript pane: the task
    // view replaced the transcript focus layer wholesale.
    expect(app.renderState.focus).toBe('tasks');
    app.stop();
  });

  it('stops the run and sends the draft on Esc', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, 'use the other file');
    press(input, 'escape');
    await settleRendered();

    expect(calls.stopAndSend).toEqual(['use the other file']);
    expect(calls.interrupted).toBe(0);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('only stops the run on Esc when there is nothing to send', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    press(input, 'escape');
    await settleRendered();

    expect(calls.interrupted).toBe(1);
    expect(calls.stopAndSend).toEqual([]);
    app.stop();
  });

  it('recalls a held draft into the composer on Esc when idle', async () => {
    const { app, input } = makeApp({ busy: false, recall: 'a draft I held back' });
    await settle();

    press(input, 'escape');
    await settleRendered();

    expect(app.inputText).toBe('a draft I held back');
    app.stop();
  });

  it('advertises the three busy keys in the status line', async () => {
    const { app, out } = makeApp({ busy: true });
    await settleRendered();

    expect(out.text()).toContain('Enter steer');
    expect(out.text()).toContain('Tab queue');
    expect(out.text()).toContain('Esc stop');
    app.stop();
  });
});

describe('command lines are not drafts', () => {
  it('still submits a slash command on Enter while a turn runs', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, '/queue');
    press(input, 'return');
    await settle();

    expect(calls.submitted).toEqual(['/queue']);
    expect(calls.steered).toEqual([]);
    expect(app.inputText).toBe('');
    app.stop();
  });

  it('still submits a bang command on Enter while a turn runs', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, '!git status');
    press(input, 'return');
    await settle();

    expect(calls.submitted).toEqual(['!git status']);
    expect(calls.steered).toEqual([]);
    app.stop();
  });

  it('leaves a slash command in the composer when Esc stops the run', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, '/queue');
    press(input, 'escape');
    await settleRendered();

    expect(calls.interrupted).toBe(1);
    expect(calls.stopAndSend).toEqual([]);
    expect(app.inputText).toBe('/queue');
    app.stop();
  });

  it('keeps Tab as indent on a slash command instead of queueing it', async () => {
    const { app, input, calls } = makeApp({ busy: true });
    await settle();

    await type(input, '/model');
    press(input, 'tab');
    await settle();

    expect(calls.queued).toEqual([]);
    expect(app.inputText).toBe('/model  ');
    app.stop();
  });
});

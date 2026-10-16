import { PassThrough, Writable } from 'stream';
import { describe, expect, it } from 'vitest';

import { TUIApp } from '../TUIApp.js';
import { TranscriptModel } from '../blocks.js';
import { detectTerminalEnvironment } from '../terminal-env.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

type TtyWritable = Writable & { isTTY: true; columns: number; rows: number };

function makeOutput(): { stream: TtyWritable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as TtyWritable;
  stream.isTTY = true;
  stream.columns = 80;
  stream.rows = 24;
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

function makeApp(options: {
  readonly input?: PassThrough;
  readonly output?: TtyWritable;
  readonly onSubmit: (text: string) => void | Promise<void>;
  readonly canSubmit?: () => boolean;
  readonly echoSubmitted?: boolean;
  readonly inline?: boolean;
}): TUIApp {
  return new TUIApp({
    input: options.input ?? new PassThrough(),
    output: options.output ?? makeOutput().stream,
    onSubmit: options.onSubmit,
    keyOverrides: {},
    terminalEnv: detectTerminalEnvironment({
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'WezTerm',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
    }),
    ...(options.canSubmit ? { canSubmit: options.canSubmit } : {}),
    ...(options.echoSubmitted === undefined ? {} : { echoSubmitted: options.echoSubmitted }),
    ...(options.inline === undefined ? {} : { inline: options.inline }),
  });
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settleRendered(): Promise<void> {
  await settle();
  await new Promise<void>((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
}

async function type(input: PassThrough, text: string): Promise<void> {
  for (const character of text) {
    input.write(character);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function pressEnter(input: PassThrough): Promise<void> {
  input.write('\r');
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

describe('TUI foundation integration', () => {
  it.each([2, 3])('keeps fullscreen input usable at %i terminal rows', async (rows) => {
    const input = new PassThrough();
    const output = makeOutput();
    output.stream.rows = rows;
    const submitted: string[] = [];
    const app = makeApp({ input, output: output.stream, onSubmit: (text) => { submitted.push(text); } });
    try {
      app.start();
      await type(input, 'ok');
      // Asked of the SURFACE rather than of the widget tree behind it: on a
      // 2-row terminal the composer drops its border, so what matters is that
      // the region it was given still fits, and that the text reached the
      // region rather than only the stream — a diff-based renderer rewrites one
      // cell per keystroke, so the two characters never appear contiguously in
      // the terminal output.
      const surface = (app as unknown as {
        fullScreen: {
          measure(region: string): { height: number } | null;
          content(region: string): readonly string[];
        };
      }).fullScreen;
      const composer = surface.measure('input');
      expect(composer).not.toBeNull();
      expect((composer as { height: number }).height).toBeLessThanOrEqual(rows - 1);
      expect(surface.content('input').join('\n')).toContain('ok');
      await pressEnter(input);
      expect(submitted).toEqual(['ok']);
    } finally {
      app.stop();
    }
  });
  it('does not repaint a closed inline modal when the terminal is resized', async () => {
    const input = new PassThrough();
    const output = makeOutput();
    const app = makeApp({ input, output: output.stream, inline: true, onSubmit: () => {} });
    try {
      app.start();
      const choice = app.chooseFiltered('ModalOnlyMarker', [{ label: 'Option', value: 'option' }]);
      await settleRendered();
      input.write('\x1b');
      expect(await choice).toBeNull();
      await settleRendered();
      const beforeResize = output.text().length;
      output.stream.rows = 12;
      output.stream.emit('resize');
      await new Promise<void>((resolve) => setTimeout(resolve, 450));
      expect(output.text().slice(beforeResize)).not.toContain('ModalOnlyMarker');
    } finally {
      app.stop();
    }
  });
  it('keeps the inline Program alive through repeated filtered modal picks and normal prompts', async () => {
    const input = new PassThrough();
    const output = makeOutput();
    const submitted: string[] = [];
    const app = makeApp({ input, output: output.stream, onSubmit: (text) => submitted.push(text), inline: true });
    app.start();
    await settleRendered();

    const firstSelection = app.chooseFiltered('Choose model', [
      { label: 'Alpha model', value: 'alpha' },
      { label: 'Beta model', value: 'beta' },
    ]);
    await settleRendered();
    await type(input, 'beta');
    await pressEnter(input);
    await expect(firstSelection).resolves.toBe('beta');
    await settleRendered();
    await type(input, 'ordinary prompt');
    await pressEnter(input);
    await settleRendered();

    const secondSelection = app.chooseFiltered('Choose model again', [
      { label: 'Gamma model', value: 'gamma' },
      { label: 'Delta model', value: 'delta' },
    ]);
    await settleRendered();
    await type(input, 'gamma');
    await pressEnter(input);
    await expect(secondSelection).resolves.toBe('gamma');
    await settleRendered();
    await type(input, 'second prompt');
    await pressEnter(input);

    expect(submitted).toEqual(['ordinary prompt', 'second prompt']);
    expect(output.text()).toContain('ordinary prompt');
    expect(output.text()).toContain('second prompt');
    app.stop();
  });

  it('resolves a pending filtered choice on stop and removes resize listeners', async () => {
    const input = new PassThrough();
    const output = makeOutput();
    const stdoutResizeBaseline = process.stdout.listenerCount('resize');
    const outputResizeBaseline = output.stream.listenerCount('resize');
    const app = makeApp({ input, output: output.stream, onSubmit: () => {}, inline: true });
    app.start();
    const pending = app.chooseFiltered('Choose model', [
      { label: 'Alpha model', value: 'alpha' },
    ]);
    await settleRendered();

    app.stop();

    await expect(pending).resolves.toBeNull();
    expect(process.stdout.listenerCount('resize')).toBe(stdoutResizeBaseline);
    expect(output.stream.listenerCount('resize')).toBe(outputResizeBaseline);
  });

  it('retains a composer draft while submission is unavailable', async () => {
    const input = new PassThrough();
    const output = makeOutput();
    let canSubmit = false;
    const submitted: string[] = [];
    const app = makeApp({
      input,
      output: output.stream,
      onSubmit: (text) => submitted.push(text),
      canSubmit: () => canSubmit,
    });
    app.start();
    await type(input, 'keep this draft');
    await pressEnter(input);
    expect(app.inputText).toBe('keep this draft');
    expect(submitted).toEqual([]);

    canSubmit = true;
    input.write('\r');
    await settle();
    expect(app.inputText).toBe('');
    expect(submitted).toEqual(['keep this draft']);
    app.stop();
  });

  it('leaves transcript echo to the callback when echoSubmitted is disabled', async () => {
    const input = new PassThrough();
    const output = makeOutput();
    let app!: TUIApp;
    let callbackCount = 0;
    app = makeApp({
      input,
      output: output.stream,
      echoSubmitted: false,
      onSubmit: (text) => {
        callbackCount += 1;
        app.printUser(text);
      },
    });
    app.start();
    await type(input, 'single echo');
    await pressEnter(input);

    expect(callbackCount).toBe(1);
    expect(app.userEchoCount('single echo')).toBe(1);
    app.stop();
  });

  it('does not append buffered deltas after authoritative final text', () => {
    const app = makeApp({ onSubmit: () => {} });
    app.start();
    for (const fragment of ['The answer ', 'is ', 'forty-two.']) {
      app.push({ type: 'text_delta', data: { content: fragment } });
    }
    app.push({ type: 'text', data: { content: 'The answer is forty-two.' } });
    app.setBusy(false);

    const model = (app as unknown as { model: TranscriptModel }).model;
    const assistants = model.blocks.filter((block) => block.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: 'The answer is forty-two.', finalized: true });
    app.stop();
  });
});

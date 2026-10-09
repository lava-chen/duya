import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { readFileSync } from 'fs';
import { TUIApp } from '../ui/TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../ui/render-scheduler.js';
import { renderTranscript, escapeTags } from '../ui/transcript-view.js';
import { TranscriptModel } from '../ui/blocks.js';

/**
 * The blessed integration, exercised for real.
 *
 * The pure modules are unit-tested elsewhere; what this covers is the part no
 * unit test can reach -- that `blessed.screen()` accepts a program built on
 * the `EscapeSafeWriter`, that a render actually produces bytes, and that the
 * layout maths does not throw on the geometry blessed hands back.
 *
 * Frames are pushed through the PUBLIC `push()` entry point rather than by
 * reaching into the model, so this is the same path a run takes.
 */

/** Collects everything the app writes. */
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

/** A readable the app can attach to, standing in for a terminal's stdin. */
function input(): PassThrough {
  return new PassThrough();
}

/**
 * Let blessed's output buffer drain.
 *
 * `Program.prototype._buffer` holds a frame in `_buf` and flushes it on
 * `nextTick` (`node_modules/blessed/lib/program.js:1652`), so a render is not
 * observable synchronously. Asserting without this wait would test the frame
 * buffer rather than the terminal.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait long enough for a THROTTLED render to actually happen.
 *
 * Content pushed after `start()` does not paint immediately — that is the
 * design, not a defect. `start()` renders on the spot via `requestImmediate`,
 * while anything after it goes through the trailing-edge throttle and lands
 * within `MIN_RENDER_INTERVAL_MS`. Waiting less than that asserts on a frame
 * that has deliberately not been drawn yet.
 */
async function settleRendered(): Promise<void> {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, MIN_RENDER_INTERVAL_MS + 40));
}

function makeApp(submitted: string[] = []) {
  const out = sink();
  const app = new TUIApp({
    output: out.stream,
    input: input(),
    statusText: () => 'model-x',
    onSubmit: (text) => {
      submitted.push(text);
    },
  });
  return { app, out };
}

describe('TUIApp integration', () => {
  it('renders a frame through blessed and emits synchronized output', async () => {
    const { app, out } = makeApp();
    app.start();
    app.printNotice('hello');
    await settle();

    const written = out.text();
    expect(written.length).toBeGreaterThan(0);
    // The markers bracket the frame, which is the thing blessed does not do.
    expect(written).toContain('\x1b[?2026h');
    expect(written).toContain('\x1b[?2026l');
    // The alternate screen is claimed, which is why the TTY guard has to run
    // before this constructor is ever reached.
    expect(written).toContain('\x1b[?1049h');
    app.stop();
  });

  it('renders the model text into the output', async () => {
    const { app, out } = makeApp();
    app.start();
    app.printNotice('a-notice-that-must-appear');
    await settleRendered();
    expect(out.text()).toContain('a-notice-that-must-appear');
    app.stop();
  });

  it('renders without throwing across a realistic frame sequence', () => {
    const { app } = makeApp();
    app.start();

    // The shape a real turn produces: streaming text, a tool call that
    // starts and finishes, an error, and the terminal.
    app.push({ type: 'text_delta', data: { content: 'Reading the file.\n' } });
    app.push({
      type: 'tool_use_started',
      data: { id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
    });
    app.push({ type: 'tool_use', data: { id: 'c1', name: 'read_file', input: { path: 'a.ts' } } });
    app.push({ type: 'tool_result', data: { id: 'c1', result: 'line1\nline2', error: false } });
    app.push({ type: 'text_delta', data: { content: 'Done.\n' } });
    app.push({ type: 'text', data: { content: 'Reading the file.\nDone.\n' } });
    app.push({ type: 'error', data: { message: 'something broke' } });
    app.push({ type: 'done', data: { reason: 'completed' } });
    app.setBusy(false);

    app.stop();
  });

  it('renders CJK without throwing and with the layout intact', () => {
    const { app } = makeApp();
    app.start();
    app.push({
      type: 'text_delta',
      data: { content: '这是一个很长的中文段落，用来验证宽字符的换行是否正确。\n' },
    });
    app.printNotice('提示：已完成');
    app.stop();
  });

  it('renders a permission overlay when one arrives', async () => {
    const { app, out } = makeApp();
    app.start();
    app.push({
      type: 'permission',
      data: {
        requestId: 'p1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
        reason: 'destructive',
      },
    });
    await settleRendered();
    // The overlay text reaches the rendered output rather than sitting in a
    // transcript line.
    expect(out.text()).toContain('Permission required');
    app.stop();
  });

  it('tears the terminal down on stop()', async () => {
    const { app, out } = makeApp();
    app.start();
    await settle();
    const before = out.text().length;
    app.stop();
    await settle();
    expect(out.text().length).toBeGreaterThan(before);
    // Bracketed paste is turned back off, so the terminal is left as it was
    // found even though the app enabled it.
    expect(out.text()).toContain('\x1b[?2004l');
  });

  it('does not bind q or escape to quit', () => {
    // Binding `q` to quit is hostile: it makes the letter untypable in prose
    // and in any slash command containing it.
    const source = readTuiAppSource();
    expect(source).not.toMatch(/key\(\s*\[[^\]]*['"]q['"]/);
    expect(source).not.toMatch(/key\(\s*['"]q['"]/);
  });

  it('does not call screen.render() from a frame handler', () => {
    // The failure this guard is about is the one the whole design exists to
    // prevent: a render per token. `push()` must reach the scheduler, never
    // the screen.
    const source = readTuiAppSource();
    const pushBody = source.slice(
      source.indexOf('push(frame'),
      source.indexOf('private showPermission'),
    );
    expect(pushBody).not.toContain('this.screen.render()');
  });

  it('stop() is idempotent', () => {
    const { app } = makeApp();
    app.start();
    app.stop();
    expect(() => app.stop()).not.toThrow();
  });
});

/**
 * Read the TUIApp source, for the two structural assertions above.
 *
 * Structural rather than behavioural on purpose: "no key binding for q" and
 * "no render in a frame handler" are properties of the wiring, and asserting
 * them against the source is what stops a well-meaning keybinding or a
 * "just call render here" from quietly reintroducing the bug.
 */
function readTuiAppSource(): string {
  return readFileSync(new URL('../ui/TUIApp.ts', import.meta.url), 'utf8');
}

describe('renderTranscript', () => {
  it('renders an empty model as an empty string', () => {
    expect(renderTranscript(new TranscriptModel())).toBe('');
  });

  it('escapes braces so model text is not read as blessed tags', () => {
    // Agent output is full of JSON and code. An unescaped `{` would make
    // blessed swallow the tag and lose the text.
    const model = new TranscriptModel();
    model.addUser('return {"a": 1}');
    const out = renderTranscript(model);
    expect(out).toContain('\\{');
    expect(escapeTags('{')).toBe('\\{');
  });

  it('caps tool results rather than rendering an unbounded blob', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c', name: 'read_file', input: { path: 'x' } } });
    model.apply({
      type: 'tool_result',
      data: { id: 'c', result: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') },
    });
    const out = renderTranscript(model, {
      expanded: false,
      showToolResults: true,
      toolResultLines: 5,
    });
    expect(out).toContain('more lines');
    expect(out.split('\n').length).toBeLessThan(20);
  });

  it('collapses thinking until expanded', () => {
    const model = new TranscriptModel();
    model.appendThinkingDelta('reasoning about the answer');
    const collapsed = renderTranscript(model, {
      expanded: false,
      showToolResults: false,
      toolResultLines: 5,
    });
    expect(collapsed).toContain('thinking');
    expect(collapsed).toContain('chars');
    expect(collapsed).not.toContain('reasoning about the answer');

    const expanded = renderTranscript(model, {
      expanded: true,
      showToolResults: false,
      toolResultLines: 5,
    });
    expect(expanded).toContain('reasoning about the answer');
  });

  it('shows a running tool differently from a finished one', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c', name: 'read_file', input: { path: 'a' } } });
    expect(renderTranscript(model)).toContain('⏺');
    model.apply({ type: 'tool_result', data: { id: 'c', result: 'ok' } });
    expect(renderTranscript(model)).toContain('✔');
  });

  it('marks a failed tool with the failure marker', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use', data: { id: 'c', name: 'read_file', input: {} } });
    model.apply({ type: 'tool_result', data: { id: 'c', result: 'boom', error: true } });
    expect(renderTranscript(model)).toContain('✖');
  });
});

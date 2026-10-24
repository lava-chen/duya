import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';

/**
 * Enter submits, driven by real bytes.
 *
 * ## Why this exists
 *
 * `bindKeys()` mixes two dispatch paths that blessed keeps apart:
 *
 * - `screen.on('keypress', ...)` is a listener on the Screen ELEMENT, fired by
 *   Screen's own handler (`blessed/lib/widgets/screen.js:592`);
 * - `screen.key(...)` is not an element listener at all. `Screen.prototype.key`
 *   forwards to `program.key` (`blessed/lib/widgets/screen.js:1726`), which
 *   registers on the PROGRAM emitter under `'key <name>'`
 *   (`blessed/lib/program.js:515-520`) and is fed by a separate broadcast in
 *   `Program._listenInput` (`program.js:408-412`).
 *
 * The two paths have different owners and different guards, so a key bound
 * through one of them can be dead while the other works — which is exactly the
 * shape of "typing works but Enter does nothing". Reading the code cannot
 * settle it, so this drives the actual bytes through a real input stream.
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
    reset: () => { chunks.length = 0; },
  };
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
 * holds the byte for 35 ms. Settling on the microtask queue alone would assert
 * against a keypress that has not been delivered yet.
 */
async function settleEscape(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
}

/**
 * Gap between keystrokes that reads as human typing rather than one paste.
 * Comfortably past `PasteBurstDetector`'s 8 ms burst window.
 *
 * Needed here because the tests below submit: a burst arms the detector, and a
 * pasted Enter is content rather than a submission. Delivering a whole word in
 * one write would make these tests pass or fail on character COUNT rather than
 * on key routing.
 */
const TYPING_INTERVAL_MS = 20;

async function type(input: PassThrough, text: string): Promise<void> {
  for (const ch of text) {
    input.write(ch);
    await new Promise((resolve) => setTimeout(resolve, TYPING_INTERVAL_MS));
  }
}

describe('TUIApp key routing', () => {
  it('submits the typed prompt when Enter arrives', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    await type(input, 'hi');
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['hi']);
    app.stop();
  });

  it('inserts own-renderer bracketed paste literally and submits it only on a later Enter', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      renderer: 'own',
      output: out.stream,
      input,
      onSubmit: (text) => { submitted.push(text); },
    });
    app.start();
    await settle();

    input.write(Buffer.from('\x1b[200~first line\r\n第二行\x1b[201~', 'utf8'));
    await settle();

    expect(app.inputText).toBe('first line\r\n第二行');
    expect(submitted).toEqual([]);
    input.write('\r');
    await settle();
    expect(submitted).toEqual(['first line\r\n第二行']);
    app.stop();
  });

  it('submits a slash command typed as a whole word', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    await type(input, '/help');
    input.write('\r');
    await settle();

    expect(submitted).toEqual(['/help']);
    app.stop();
  });

  it('does not submit on Enter when the input is empty', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => {
        submitted.push(text);
      },
    });
    app.start();
    await settle();

    input.write('\r');
    await settle();

    expect(submitted).toEqual([]);
    app.stop();
  });

  /**
   * Ctrl+D, driven by real bytes for the same reason Enter is: `bindKeys`
   * mixes two dispatch paths blessed keeps apart, so a binding can look right
   * in code and still be dead. `\x04` is what a terminal actually sends.
   */
  it('exits on Ctrl+D when the input is empty', async () => {
    const out = sink();
    const input = new PassThrough();
    const exited: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: () => {},
      onExit: () => { exited.push('exit'); },
    });
    app.start();
    await settle();

    input.write('\x04');
    await settle();

    expect(exited).toEqual(['exit']);
    app.stop();
  });

  it('leaves Ctrl+D inert when there is text to lose', async () => {
    const out = sink();
    const input = new PassThrough();
    const exited: string[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: () => {},
      onExit: () => { exited.push('exit'); },
    });
    app.start();
    await settle();

    await type(input, 'half a sentence');
    input.write('\x04');
    await settle();

    // The editor is untouched too: this is not delete-forward. A reflexive
    // Ctrl+D that costs the user their draft is the worse trade.
    expect(exited).toEqual([]);
    expect(app.inputText).toBe('half a sentence');
    app.stop();
  });

  it('moves between the input and the task view, selecting and opening rows', async () => {
    const out = sink();
    const input = new PassThrough();
    const submitted: string[] = [];
    const opened: string[] = [];
    const refreshed: number[] = [];
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: (text) => { submitted.push(text); },
      onBackgroundTaskOpen: (task) => { opened.push(task.id); },
      onBackgroundTasksRefresh: () => { refreshed.push(1); },
    });
    app.start();
    app.setBackgroundTasks({
      observed: true,
      tasks: [
        { id: 'bash-running', command: 'npm run dev', status: 'running', startedAtMs: 2_000 },
        { id: 'bash-done', command: 'npm test', status: 'completed', startedAtMs: 1_000, endedAtMs: 1_500, exitCode: 0 },
      ],
    });
    await settleRendered();

    // F6 enters the task view. Rows are the bash group heading followed by its
    // tasks, running first — the same order the view paints.
    input.write('\x1b[17~');
    await settle();
    expect(app.renderState.focus).toBe('tasks');
    expect(app.backgroundTaskRows().map((row) => row.kind)).toEqual(['group', 'task', 'task', 'group']);
    expect(app.renderState.selectedTaskRow).toBe(0);
    expect(refreshed).toHaveLength(1);

    // Arrows move the task selection, never the editor's history.
    input.write('\x1b[B');
    await settle();
    expect(app.renderState.selectedTaskRow).toBe(1);
    input.write('\x1b[B');
    await settle();
    expect(app.renderState.selectedTaskRow).toBe(2);
    expect(app.inputText).toBe('');

    // Enter on a task row asks the chat loop to open it; the row stays put.
    input.write('\r');
    await settle();
    expect(opened).toEqual(['bash-done']);
    expect(app.renderState.selectedTaskRow).toBe(2);

    // Esc returns the arrows to the composer.
    input.write('\x1b');
    await settleEscape();
    expect(app.renderState.focus).toBe('input');

    // Re-entering starts at the first row again.
    input.write('\t');
    await settle();
    expect(app.renderState.focus).toBe('tasks');
    expect(app.renderState.selectedTaskRow).toBe(0);

    // Left folds the group the selection is on (a heading row folds its own
    // group); right unfolds it.
    input.write('\x1b[D');
    await settle();
    expect(app.backgroundTaskRows().map((row) => row.kind)).toEqual(['group', 'group']);
    input.write('\x1b[C');
    await settle();
    expect(app.backgroundTaskRows()).toHaveLength(4);

    // Tab leaves the task view and behaves as indent in the composer again.
    input.write('\t');
    await settle();
    expect(app.renderState.focus).toBe('input');
    await type(input, 'x');
    input.write('\t');
    await settle();
    expect(app.inputText).toBe('x  ');
    input.write('\x1b[17~');
    await settle();
    expect(app.renderState.focus).toBe('tasks');
    input.write('\t');
    await settle();
    expect(app.renderState.focus).toBe('input');
    input.write('\r');
    await settle();
    expect(submitted).toEqual(['x']);
    app.stop();
  });

  it('enters an empty task view without a selection and leaves it on Esc', async () => {
    const out = sink();
    const input = new PassThrough();
    const app = new TUIApp({
      output: out.stream,
      input,
      onSubmit: () => {},
    });
    app.start();
    app.setBackgroundTasks({ observed: true, tasks: [] });
    await settleRendered();

    input.write('\x1b[17~');
    await settle();
    expect(app.renderState.focus).toBe('tasks');
    // Nothing to select: an index into an empty row list would be a phantom
    // selection the arrows could move but Enter could never open.
    expect(app.renderState.selectedTaskRow).toBe(-1);

    input.write('\x1b[B');
    await settle();
    expect(app.renderState.selectedTaskRow).toBe(-1);
    input.write('\r');
    await settle();

    input.write('\x1b');
    await settleEscape();
    expect(app.renderState.focus).toBe('input');
    // The inline empty-state text is asserted in the wired view test; this
    // suite drives the non-inline shell, which paints no chrome task list.
    app.stop();
  });
});

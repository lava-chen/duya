/**
 * The background-task view, wired into the live area.
 *
 * `background-tasks.test.ts` proves the model. This proves the two surfaces
 * the user actually sees: the persistent summary row that survives the end of
 * a turn, and the list the arrows drive once F6 (or `/tasks`) takes focus.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough, Writable } from 'stream';

import { TUIApp } from '../TUIApp.js';
import { detectTerminalEnvironment } from '../terminal-env.js';
import { IDLE_TASK_GLYPH_UNICODE, SPINNER_UNICODE } from '../working-tail.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';
import type { BackgroundTaskView } from '../background-tasks.js';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleRendered(): Promise<void> {
  await sleep(0);
  await sleep(0);
  await sleep(MIN_RENDER_INTERVAL_MS + 40);
  await sleep(0);
}

function makeApp() {
  const out = sink();
  const input = new PassThrough();
  const opened: BackgroundTaskView[] = [];
  const app = new TUIApp({
    output: out.stream,
    input,
    inline: true,
    terminalEnv: detectTerminalEnvironment({ TERM_PROGRAM: 'WezTerm' }),
    isBusy: () => false,
    onSubmit: () => {},
    onBackgroundTaskOpen: (task) => { opened.push(task); },
  });
  return { app, out, input, opened };
}

/** Press a key the way a terminal sends it. */
function press(input: PassThrough, bytes: string): void {
  input.write(bytes);
}

/**
 * The last frame in the write stream.
 *
 * The renderer writes whole frames; asserting "absent" against the whole
 * stream would count a row that was on screen BEFORE the key and blanked
 * after it. What the user ends up looking at is the final frame.
 */
function lastFrame(text: string): string {
  const frames = text.split('\x1b[?2026h');
  return frames[frames.length - 1] ?? '';
}

const F6 = '\x1b[17~';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const ENTER = '\r';
const ESC = '\x1b';

describe('the background summary row', () => {
  it('sits under the conversation while a background command runs', async () => {
    const { app, out } = makeApp();
    app.start();
    app.setBackgroundTasks({
      observed: true,
      tasks: [{ id: 'task-1', command: 'npm run dev', status: 'running', startedAtMs: Date.now() - 12_000 }],
    });
    await settleRendered();
    app.stop();

    const text = out.text();
    expect(text).toContain('1 background');
    expect(text).toContain('/tasks details');
    // The turn is not running, so the glyph is a static dot — a spinning row
    // with nothing moving would read as a hang.
    expect(text).toContain(IDLE_TASK_GLYPH_UNICODE);
    expect([...text].some((ch) => SPINNER_UNICODE.includes(ch))).toBe(false);
  });

  it('keeps the details hint after the last task finishes', async () => {
    const { app, out } = makeApp();
    app.start();
    app.setBackgroundTasks({
      observed: true,
      tasks: [{ id: 'task-1', command: 'npm test', status: 'completed', startedAtMs: 1_000, endedAtMs: 2_000 }],
    });
    await settleRendered();
    app.stop();

    const text = out.text();
    // Nothing is running, so no running count is claimed...
    expect(text).not.toContain('1 background');
    // ...but the row survives so the finished task can still be inspected.
    expect(text).toContain('/tasks details');
  });

  it('counts subagents from run frames', async () => {
    const { app, out } = makeApp();
    app.start();
    app.push({
      type: 'agent_progress',
      data: {
        agentEventType: 'subagent_started',
        subagentId: 'sub-1',
        agentName: 'Scout',
        agentType: 'explore',
      },
    });
    await settleRendered();
    app.stop();

    expect(out.text()).toContain('1 subagent');
    expect(out.text()).toContain('/tasks details');
  });
});

describe('the task list', () => {
  async function withTwoTasks() {
    const harness = makeApp();
    harness.app.start();
    harness.app.setBackgroundTasks({
      observed: true,
      tasks: [
        { id: 'bash-running', command: 'npm run dev', status: 'running', startedAtMs: 2_000 },
        { id: 'bash-done', command: 'npm test', status: 'completed', startedAtMs: 1_000, endedAtMs: 1_500 },
      ],
    });
    harness.app.push({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-1', agentName: 'Scout', agentType: 'explore' },
    });
    await settleRendered();
    return harness;
  }

  it('paints the list in the live area, never the scrollback', async () => {
    const { app, out, input } = await withTwoTasks();
    press(input, F6);
    await settleRendered();
    app.stop();

    const text = out.text();
    expect(text).toContain('Tasks · ↑↓ select · ←→ fold · Enter open · Esc back');
    expect(text).toContain('▾ Background bash (2) · 1 running');
    expect(text).toContain('▾ Subagents (1) · 1 running');
    // Running first, then the finished one.
    expect(text.indexOf('npm run dev')).toBeLessThan(text.indexOf('npm test'));
    expect(text).toContain('Scout');
  });

  it('moves the selection marker with the arrows', async () => {
    const { app, out, input } = await withTwoTasks();
    press(input, F6);
    await settleRendered();
    out.reset();
    press(input, DOWN);
    await settleRendered();
    app.stop();

    // Row 0 is the bash heading, row 1 the running task.
    expect(out.text()).toContain('❯ ● npm run dev');
  });

  it('opens the selected task on Enter without leaving the view', async () => {
    const { app, input, opened } = await withTwoTasks();
    press(input, F6);
    await settleRendered();
    press(input, DOWN);
    press(input, ENTER);
    await settleRendered();
    app.stop();

    expect(opened.map((task) => task.id)).toEqual(['bash-running']);
    expect(app.renderState.focus).toBe('tasks');
  });

  it('folds the group at the selection with Left and unfolds with Right', async () => {
    const { app, out, input } = await withTwoTasks();
    press(input, F6);
    await settleRendered();

    out.reset();
    press(input, LEFT);
    await settleRendered();
    expect(lastFrame(out.text())).toContain('▸ Background bash');
    expect(lastFrame(out.text())).not.toContain('npm run dev');
    expect(lastFrame(out.text())).toContain('Scout');
    // The bash heading stays; only its children fold away. The subagent group
    // was never touched and keeps its own row.
    expect(app.backgroundTaskRows().map((row) => row.kind)).toEqual(['group', 'group', 'task']);

    out.reset();
    press(input, RIGHT);
    await settleRendered();
    app.stop();
    expect(lastFrame(out.text())).toContain('▾ Background bash');
    expect(lastFrame(out.text())).toContain('npm run dev');
  });

  it('leaves the view on Esc and stops painting the list', async () => {
    const { app, out, input } = await withTwoTasks();
    press(input, F6);
    await settleRendered();

    out.reset();
    press(input, ESC);
    // A bare Escape is held until the parser knows no sequence follows.
    await sleep(60);
    await settleRendered();
    app.stop();

    expect(app.renderState.focus).toBe('input');
    expect(lastFrame(out.text())).not.toContain('Tasks · ↑↓ select');
    // The summary stays: leaving the view is not the same as stopping the work.
    expect(out.text()).toContain('/tasks details');
  });

  it('says so when the Host cannot answer, rather than claiming emptiness', async () => {
    const { app, out, input } = makeApp();
    app.start();
    app.setBackgroundTasks({ observed: false, tasks: [] });
    await settleRendered();
    press(input, F6);
    await settleRendered();
    app.stop();

    expect(out.text()).toContain('Background task list unavailable for this Host.');
    expect(out.text()).not.toContain('No background tasks.');
  });

  it('treats an observed empty list as genuinely empty', async () => {
    const { app, out, input } = makeApp();
    app.start();
    app.setBackgroundTasks({ observed: true, tasks: [] });
    await settleRendered();
    press(input, F6);
    await settleRendered();
    app.stop();

    expect(out.text()).toContain('No background tasks.');
  });
});

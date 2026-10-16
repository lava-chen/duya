/**
 * The ask-user-question overlay, driven through the real blessed app.
 *
 * The end-to-end contract this pins: an `ask_user_question` request routes to
 * the QUESTIONNAIRE (not the allow/deny picker), the keys drive it, and the
 * submitted answers ride `onPermissionDecision`'s third argument — the channel
 * the wiring turns into `storePendingAnswer`, which the tool's Phase-2 retry
 * reads. A decision-only resolution would silently drop every answer.
 */

import { describe, it, expect } from 'vitest';
import { Writable, PassThrough } from 'stream';
import { TUIApp } from '../TUIApp.js';
import { MIN_RENDER_INTERVAL_MS } from '../render-scheduler.js';
import type { QuestionAnswers } from '../overlay.js';

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
}

/**
 * Whitespace-stripped screen text.
 *
 * The renderer positions each cell, so a phrase with spaces can come back with
 * them eaten by cursor moves; comparing without whitespace is the only stable
 * way to assert on prose in the output stream.
 */
function flat(text: string): string {
  return text.replace(/\s+/gu, '');
}

function makeApp(stdin: PassThrough) {
  const out = sink();
  const app = new TUIApp({
    output: out.stream,
    input: stdin,
    canAnswerPermissions: () => true,
    onSubmit: () => {},
    keyOverrides: {},
  });
  return { app, out };
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which auth approach?',
      header: 'Auth',
      options: [
        { label: 'Session cookies', description: 'Server-rendered' },
        { label: 'JWT' },
      ],
      multiSelect: false,
    },
  ],
};

describe('TUIApp ask-user-question overlay', () => {
  it('renders the questionnaire and submits a quick-picked answer', async () => {
    const answers: Array<{ id: string; answers?: QuestionAnswers }> = [];
    const stdin = new PassThrough();
    const { app, out } = makeApp(stdin);
    app.onPermissionDecision = (id, _decision, captured) => answers.push({ id, answers: captured });
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'a1',
      toolName: 'ask_user_question',
      toolInput: QUESTION_INPUT,
      reason: '',
      mode: 'ask_user_question',
    });
    await settleRendered();
    const screen = flat(out.text());
    expect(screen).toContain('Question1/1');
    expect(screen).toContain('Whichauthapproach?');
    expect(screen).toContain('Sessioncookies');
    expect(screen).not.toContain('Alwaysallowthissession');

    stdin.write('2'); // quick-pick JWT → submit
    await settle();

    expect(await pending).toBe('once');
    expect(answers).toEqual([{ id: 'a1', answers: { 'Which auth approach?': 'JWT' } }]);
    app.stop();
  });

  it('submits a notes-only answer typed from scratch', async () => {
    const stdin = new PassThrough();
    const { app } = makeApp(stdin);
    let captured: QuestionAnswers | undefined;
    app.onPermissionDecision = (_id, _decision, answers) => {
      captured = answers;
    };
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'a2',
      toolName: 'ask_user_question',
      toolInput: QUESTION_INPUT,
      reason: '',
      mode: 'ask_user_question',
    });
    await settleRendered();
    stdin.write('x');
    await settle();
    stdin.write('\r');
    await settle();

    expect(await pending).toBe('once');
    expect(captured).toEqual({ 'Which auth approach?': 'x' });
    app.stop();
  });

  it('Esc cancels the questionnaire without submitting answers', async () => {
    const stdin = new PassThrough();
    const { app } = makeApp(stdin);
    const decisions: Array<{ decision: unknown; answers?: QuestionAnswers }> = [];
    app.onPermissionDecision = (_id, decision, answers) => decisions.push({ decision, answers });
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'a3',
      toolName: 'ask_user_question',
      toolInput: QUESTION_INPUT,
      reason: '',
      mode: 'ask_user_question',
    });
    await settleRendered();
    stdin.write('\x1b'); // Esc
    await settle();

    expect(await pending).toBeNull();
    expect(decisions).toEqual([{ decision: null, answers: undefined }]);
    app.stop();
  });

  it('falls back to the allow/deny picker when the input cannot be parsed', async () => {
    const stdin = new PassThrough();
    const { app, out } = makeApp(stdin);
    app.start();
    await settle();

    const pending = app.requestPermissionApproval({
      requestId: 'a4',
      toolName: 'ask_user_question',
      toolInput: { questions: 'not-an-array' },
      reason: '',
      mode: 'ask_user_question',
    });
    await settleRendered();
    // Degraded, but honest: the picker still answers rather than showing a
    // broken questionnaire.
    const screen = flat(out.text());
    expect(screen).toContain('Permissionrequired');
    expect(screen).not.toContain('Question1/1');
    stdin.write('y');
    await settle();
    expect(await pending).toBe('once');
    app.stop();
  });
});

/**
 * packages/cli/src/tui/slash/__tests__/btw.test.ts
 *
 * `/btw` — the side question that does NOT interrupt the running turn.
 *
 * ## What these cases pin
 *
 *  1. `/btw` works WHILE a turn is streaming. That is the whole point of
 *     the command: the interesting moment to ask a side question is while
 *     the agent is working on something else. A handler that refused here
 *     would make the command useless.
 *
 *  2. A missing question is asked for, through the TUI's own prompt — the
 *     same mechanism `/rename` uses — rather than sent to the model as an
 *     empty string.
 *
 *  3. A failure is reported as a failure. An empty or missing answer is
 *     reported as empty, not dressed up as an answer.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { BTW_COMMANDS } from '../btw.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-btw-1';

const COMMAND = BTW_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the btw command is not exported');

// ───────────────────────────── fixtures ─────────────────────────────

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  /** Every `askSideQuestion` call: [sessionId, question]. */
  readonly calls: Array<{ sessionId: string; question: string }>;
  readonly output: string;
}

/**
 * Run `/btw` against a client that answers `answer` (or throws `error`).
 */
async function run(options: {
  readonly answer?: string;
  readonly error?: Error;
  readonly args?: string;
  readonly busy?: boolean;
  readonly sessionId?: string | undefined;
  /** What the TUI's text prompt answers, when there is one. */
  readonly prompt?: string | null;
  readonly withPrompt?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ sessionId: string; question: string }> = [];

  const client = {
    askSideQuestion: vi.fn(async (sessionId: string, question: string) => {
      calls.push({ sessionId, question });
      if (options.error !== undefined) throw options.error;
      return { answer: options.answer ?? 'A side answer.' };
    }),
  } as unknown as HostSessionHttpClient;

  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    ...(options.withPrompt === false
      ? {}
      : { promptText: async () => (options.prompt === undefined ? null : options.prompt) }),
  };

  const ctx = {
    client,
    session: { id: options.sessionId === undefined ? SESSION_ID : options.sessionId },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, options.args ?? '');

  return { notices, errors, calls, output: notices.join('\n') };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/btw', () => {
  it('declares the canonical name with no aliases', () => {
    // The catalog is the naming authority: `btw` has no aliases there, so
    // a handler that invented one would advertise a spelling the popup
    // does not show.
    expect(COMMAND.name).toBe('btw');
    expect(COMMAND.aliases ?? []).toEqual([]);
    expect(COMMAND.argsHint).toBe('[question]');
    expect(COMMAND.group).toBe('Session ops');
  });

  it('asks the question it was given and prints the answer', async () => {
    const { calls, notices, errors } = await run({
      args: 'what is the difference between a run and a turn?',
      answer: 'A run is the envelope; a turn is one exchange inside it.',
    });

    expect(errors).toEqual([]);
    expect(calls).toEqual([
      { sessionId: SESSION_ID, question: 'what is the difference between a run and a turn?' },
    ]);
    expect(notices.join('\n')).toContain('A run is the envelope');
  });

  it('asks for the question when the command was typed bare', async () => {
    const { calls, notices } = await run({
      prompt: 'why did you choose that retry policy?',
      answer: 'Because the Host owns the retry budget.',
    });

    // The question came from the TUI's own prompt, not from an empty
    // argument forwarded to the model.
    expect(calls).toEqual([
      { sessionId: SESSION_ID, question: 'why did you choose that retry policy?' },
    ]);
    expect(notices.join('\n')).toContain('Because the Host owns the retry budget');
  });

  it('prints the usage when there is no prompt to ask with', async () => {
    const { calls, errors } = await run({ withPrompt: false });

    expect(errors.join('\n')).toContain('Usage: /btw <question>');
    // Nothing was asked: an empty side call is not a side question.
    expect(calls).toEqual([]);
  });

  it('does nothing when the prompt is cancelled', async () => {
    const { calls, errors } = await run({ prompt: null });

    expect(calls).toEqual([]);
    // Cancelling the prompt is not an error.
    expect(errors).toEqual([]);
  });

  it('runs while a turn is streaming', async () => {
    // The catalog marks `btw` as safe while busy, and that is the whole
    // point of the command: the side question must not be refused because
    // a turn happens to be running.
    const { calls, errors } = await run({
      busy: true,
      args: 'is there a cheaper model for this?',
      answer: 'Yes.',
    });

    expect(errors).toEqual([]);
    expect(calls.length).toBe(1);
  });

  it('refuses without a session', async () => {
    const { calls, errors } = await run({ sessionId: '', args: 'anything?' });

    expect(errors.join('\n')).toContain('needs a session');
    expect(calls).toEqual([]);
  });

  it('reports a failure as a failure', async () => {
    const { calls, errors, notices } = await run({
      args: 'anything?',
      error: new Error('Host is unreachable'),
    });

    expect(errors.join('\n')).toContain('Side question failed');
    expect(errors.join('\n')).toContain('Host is unreachable');
    // A failed side call produced no answer, and none is printed.
    expect(notices.join('\n')).not.toContain('Side answer');
    expect(calls.length).toBe(1);
  });

  it('says so when the answer comes back empty', async () => {
    const { notices, errors } = await run({ args: 'anything?', answer: '   ' });

    expect(errors).toEqual([]);
    expect(notices.join('\n')).toContain('came back empty');
  });
});

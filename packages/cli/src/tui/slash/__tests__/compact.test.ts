/**
 * packages/cli/src/tui/slash/__tests__/compact.test.ts
 *
 * `/compact` — the CLI side of manual context compaction.
 *
 * ## What these cases pin
 *
 *  1. A busy turn is refused LOCALLY. The Host would answer 409
 *     `session_busy` too, but the command must not even ask: compaction
 *     rewrites the context the running turn is reading from.
 *
 *  2. The terminal frame is the only one reported. A keepalive every 15
 *     seconds must not turn one command into a wall of noise.
 *
 *  3. Each Host refusal reads differently. "This Host cannot compact",
 *     "this session is gone", "a turn is running", "a compaction is
 *     already running" and "no worker is alive" are five different
 *     problems with five different fixes.
 *
 *  4. A successful compaction reloads the transcript, so the user sees
 *     the compacted conversation rather than the pre-compaction one.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { COMPACT_COMMANDS } from '../compact.js';
import type { TuiSlashActions, TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-compact-1';

const COMMAND = COMPACT_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the compact command is not exported');

// ───────────────────────────── fixtures ─────────────────────────────

/** One SSE frame as the Host's client yields it. */
interface Frame {
  readonly event: string;
  readonly data: unknown;
}

/** A Host HTTP error, shaped like the one the client throws. */
function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  /** Every `compactSession` call: [sessionId, options]. */
  readonly calls: Array<{ sessionId: string; options: unknown }>;
  /** Every session id `reloadTranscript` was asked to re-read. */
  readonly reloads: string[];
  readonly output: string;
}

/**
 * Run `/compact` against a client whose `compactSession` yields `frames`
 * (or throws `error`).
 */
async function run(options: {
  readonly frames?: readonly Frame[];
  readonly error?: Error;
  readonly args?: string;
  readonly busy?: boolean;
  readonly withActions?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ sessionId: string; options: unknown }> = [];
  const reloads: string[] = [];

  const client = {
    compactSession: vi.fn(async function* (
      sessionId: string,
      requestOptions?: unknown,
    ) {
      calls.push({ sessionId, options: requestOptions });
      if (options.error !== undefined) throw options.error;
      for (const frame of options.frames ?? []) yield frame;
    }),
  } as unknown as HostSessionHttpClient;

  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
  };

  const actions: TuiSlashActions = {
    interrupt: () => {},
    adoptSession: async () => {},
    startFreshSession: async () => {},
    reloadTranscript: async (sessionId) => { reloads.push(sessionId); },
  };

  const ctx = {
    client,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
    ...(options.withActions === false ? {} : { actions }),
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, options.args ?? '');

  return { notices, errors, calls, reloads, output: notices.join('\n') };
}

// ───────────────────────────── cases ─────────────────────────────

describe('/compact', () => {
  it('declares the canonical name with no aliases', () => {
    // The catalog is the naming authority: `compact` has no aliases there,
    // so a handler that invented one would advertise a spelling the popup
    // does not show.
    expect(COMMAND.name).toBe('compact');
    expect(COMMAND.aliases ?? []).toEqual([]);
    expect(COMMAND.argsHint).toBe('[instructions]');
    expect(COMMAND.group).toBe('Session ops');
  });

  it('refuses while a turn is streaming, without asking the Host', async () => {
    const { errors, calls, output } = await run({
      busy: true,
      frames: [{ event: 'compact:completed', data: {} }],
    });

    expect(errors.join('\n')).toContain('while a turn is running');
    // The refusal is local: compaction rewrites the context the running
    // turn reads from, so the Host must never be asked.
    expect(calls).toEqual([]);
    expect(output).toEqual('');
  });

  it('reports the outcome and reloads the transcript when the compaction completes', async () => {
    const { notices, errors, reloads } = await run({
      frames: [
        { event: 'compact:started', data: { sessionId: SESSION_ID } },
        { event: 'compact:keepalive', data: { at: 1 } },
        {
          event: 'compact:completed',
          data: {
            status: 'ok',
            strategy: 'summary',
            removedCount: 12,
            messageCount: 4,
            tokensRemoved: 3400,
            tokensRetained: 900,
          },
        },
      ],
    });

    expect(errors).toEqual([]);
    const output = notices.join('\n');
    expect(output).toContain('removed 12 messages');
    expect(output).toContain('freed ~3.4k tokens');
    expect(output).toContain('kept ~900 tokens');
    // The transcript on screen is the pre-compaction one; it has to be
    // re-read for the user to see the compacted conversation.
    expect(reloads).toEqual([SESSION_ID]);
  });

  it('does not print a line per keepalive frame', async () => {
    const { notices } = await run({
      frames: [
        { event: 'compact:started', data: {} },
        { event: 'compact:keepalive', data: { at: 1 } },
        { event: 'compact:keepalive', data: { at: 2 } },
        { event: 'compact:keepalive', data: { at: 3 } },
        { event: 'compact:completed', data: { removedCount: 1 } },
      ],
    });

    // One "something is happening" line and one outcome line. A keepalive
    // per 15s would be a wall of noise.
    expect(notices.length).toBe(2);
    expect(notices[0]).toContain('Compacting');
    expect(notices[1]).toContain('Compacted');
  });

  it('reports the server\'s own failure code and message', async () => {
    const { notices, errors, reloads } = await run({
      frames: [{
        event: 'compact:failed',
        data: { status: 'error', code: 'compaction_empty', message: 'conversation is empty' },
      }],
    });

    expect(errors.join('\n')).toContain('compaction_empty');
    expect(errors.join('\n')).toContain('conversation is empty');
    // A failed compaction changed nothing, so the transcript is not re-read.
    expect(reloads).toEqual([]);
    expect(notices.join('\n')).not.toContain('Compacted:');
  });

  it('does not pretend a compaction happened when the stream ends without a result', async () => {
    const { errors, reloads } = await run({
      frames: [{ event: 'compact:started', data: {} }],
    });

    expect(errors.join('\n')).toContain('without a result');
    expect(reloads).toEqual([]);
  });

  it('sends no instructions when the command was typed bare', async () => {
    const { calls } = await run({ frames: [{ event: 'compact:completed', data: {} }] });

    expect(calls.length).toBe(1);
    expect(calls[0]?.sessionId).toBe(SESSION_ID);
    // No options at all: the worker picks its own default strategy.
    expect(calls[0]?.options).toBeUndefined();
  });

  it('forwards the whole argument as the compaction instructions', async () => {
    const { calls } = await run({
      args: '  keep the API notes, drop the debug logs  ',
      frames: [{ event: 'compact:completed', data: {} }],
    });

    expect(calls[0]?.options).toEqual({ instructions: 'keep the API notes, drop the debug logs' });
  });

  it('gives each Host refusal its own sentence', async () => {
    const cases: ReadonlyArray<{ status: number; code: string; expected: string }> = [
      { status: 404, code: 'agent_compaction_unavailable', expected: 'does not serve manual compaction' },
      { status: 404, code: 'session_not_found', expected: 'not on this Host' },
      { status: 409, code: 'session_busy', expected: 'running turn' },
      { status: 409, code: 'compact_in_flight', expected: 'already running' },
      { status: 409, code: 'no_live_worker', expected: 'send a message first' },
    ];

    const messages: string[] = [];
    for (const testCase of cases) {
      const { errors, reloads } = await run({ error: hostError(testCase.status, testCase.code) });
      const message = errors.join('\n');
      expect(message, testCase.code).toContain(testCase.expected);
      messages.push(message);
      // A refusal changes nothing.
      expect(reloads, testCase.code).toEqual([]);
    }

    // Five different problems, five different sentences: a user who reads
    // one of them must be able to tell which problem they hit.
    expect(new Set(messages).size).toBe(cases.length);
  });

  it('reports an unexpected Host failure without a stack trace', async () => {
    const { errors } = await run({ error: hostError(500, 'internal_error') });

    expect(errors.join('\n')).toContain('Compaction failed');
    expect(errors.join('\n')).toContain('internal_error');
    expect(errors.join('\n')).not.toContain('at ');
  });

  it('says the compaction keeps running when the client stops watching', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const { notices, errors } = await run({ error: abort });

    // The worker does not stop when the client does, so claiming it was
    // cancelled would be a lie about the session.
    expect(notices.join('\n')).toContain('still running on the Host');
    expect(errors).toEqual([]);
  });

  it('says so when the surface cannot repaint the transcript', async () => {
    const { notices, reloads } = await run({
      withActions: false,
      frames: [{ event: 'compact:completed', data: { removedCount: 3 } }],
    });

    expect(notices.join('\n')).toContain('cannot repaint the transcript');
    expect(reloads).toEqual([]);
  });
});

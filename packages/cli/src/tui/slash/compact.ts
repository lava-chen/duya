/**
 * packages/cli/src/tui/slash/compact.ts
 *
 * `/compact [instructions]` — compact the current session's context.
 *
 * ## The work is the Host's, not the CLI's
 *
 * Compaction runs inside the session's worker (the model is asked to
 * summarise the conversation), so the CLI cannot do it locally: it asks
 * the Host over HTTP and reads the outcome from the SSE stream the Host
 * answers with. The CLI adds no summarising of its own — a second
 * implementation here would be a second answer to "what does this session
 * contain now", and the two would drift.
 *
 * ## Why the CLI refuses locally while a turn streams
 *
 * Compaction rewrites the context the running turn is reading from, so it
 * must not happen mid-turn. The Host answers 409 `session_busy` for the
 * same reason, but the user typed a command that obviously cannot run:
 * saying so here is faster and clearer than a round trip that is going
 * to be refused. The catalog already marks `compact` as not safe while
 * busy, so the popup does not offer it then either.
 *
 * ## The stream
 *
 * The Host answers with SSE frames: `compact:started`,
 * `compact:keepalive`, `compact:completed` and `compact:failed`. Only the
 * terminal frame is reported — a keepalive every 15 seconds would turn
 * one command into a wall of noise, and the user is told once that
 * something is happening.
 *
 * ## Refusals
 *
 * The Host answers a pre-flight refusal with a JSON error instead of the
 * stream, so `compactSession` throws before any frame arrives. Each
 * refusal has its own sentence: "this Host cannot compact", "this session
 * is gone", "a turn is running", "a compaction is already running" and
 * "no worker is alive" are five different problems with five different
 * fixes, and a single generic message would hide which one happened.
 *
 * ## The client methods
 *
 * The two Host client methods this command needs are declared here as a
 * narrow structural type rather than imported, because the Host-side
 * exits land in a parallel branch. The shapes are the ones the Host
 * publishes, so the cast disappears on its own once they are there.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, formatTokens, hostErrorCode } from './shared.js';

/**
 * The Host client surface this command calls.
 *
 * `compactSession` answers with SSE frames; the terminal one carries the
 * result. `data` stays `unknown` here on purpose — it crosses the
 * network — and is narrowed by the readers below.
 */
interface CompactCapableClient {
  compactSession(
    sessionId: string,
    options?: { instructions?: string; signal?: AbortSignal },
  ): AsyncIterable<{ event: string; data: unknown }>;
}

/**
 * The refusal sentences, keyed by the Host's error code.
 *
 * Each one names what is missing and what to do about it, because each
 * one has a different fix: install the capability, open another session,
 * wait for the turn, wait for the running compaction, or send a message
 * so a worker starts.
 */
const COMPACTION_REFUSALS: Readonly<Record<string, string>> = {
  agent_compaction_unavailable:
    'This Host does not serve manual compaction — the capability is not installed on it.',
  session_not_found: 'This session is not on this Host.',
  session_busy: 'This session still has a running turn — wait for it to finish, then compact.',
  compact_in_flight: 'A compaction is already running for this session.',
  no_live_worker:
    'No worker is running for this session — send a message first so the worker starts.',
};

/** A numeric field of an unknown payload, or null when it is not one. */
function numberField(data: unknown, key: string): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as { readonly [k: string]: unknown })[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A string field of an unknown payload, or null when it is not one. */
function stringField(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as { readonly [k: string]: unknown })[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The outcome line for a completed compaction.
 *
 * The Host reports what it removed and what it kept; every number is
 * optional here because the frame crosses the network and a missing
 * field must not invent a count.
 */
function outcomeLine(data: unknown): string {
  const removed = numberField(data, 'removedCount');
  const tokensRemoved = numberField(data, 'tokensRemoved');
  const tokensRetained = numberField(data, 'tokensRetained');
  const parts: string[] = [];
  if (removed !== null) parts.push(`removed ${removed} message${removed === 1 ? '' : 's'}`);
  if (tokensRemoved !== null) parts.push(`freed ~${formatTokens(tokensRemoved)} tokens`);
  if (tokensRetained !== null) parts.push(`kept ~${formatTokens(tokensRetained)} tokens`);
  if (parts.length === 0) return 'Compacted the session context.';
  return `Compacted: ${parts.join(', ')}.`;
}

/** True for the error a cancelled fetch raises. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Refuse a compaction while a turn streams; returns true if refused.
 *
 * Same shape as the refusal the other session commands use: the command
 * names what cannot happen now and what to do about it.
 */
function refuseWhileBusy(ctx: TuiSlashContext): boolean {
  if (!ctx.busy) return false;
  ctx.tui.printError('Cannot compact while a turn is running — press Esc first.');
  return true;
}

const COMPACT_COMMAND: TuiSlashCommandDef = {
  name: 'compact',
  argsHint: '[instructions]',
  description: 'Compress conversation context to save tokens',
  group: 'Session ops',
  async run(ctx: TuiSlashContext, args: string) {
    if (refuseWhileBusy(ctx)) return { kind: 'handled' };

    const instructions = args.trim();
    const client = ctx.client as unknown as CompactCapableClient;

    // Say once that something is happening: a compaction is a multi-minute
    // model call, and a command that prints nothing until it ends reads as
    // a command that does nothing.
    ctx.tui.printNotice('Compacting the session context — this can take a minute.');

    let terminal: 'completed' | 'failed' | null = null;
    try {
      for await (const frame of client.compactSession(
        ctx.session.id,
        instructions === '' ? undefined : { instructions },
      )) {
        if (frame.event === 'compact:completed') {
          ctx.tui.printNotice(outcomeLine(frame.data));
          terminal = 'completed';
          break;
        }
        if (frame.event === 'compact:failed') {
          const code = stringField(frame.data, 'code');
          const message = stringField(frame.data, 'message');
          const detail = code === null ? message : message === null ? code : `${code}: ${message}`;
          ctx.tui.printError(detail === null ? 'Compaction failed.' : `Compaction failed: ${detail}`);
          terminal = 'failed';
          break;
        }
        // `compact:started` and `compact:keepalive` say nothing the user
        // does not already know.
      }
    } catch (error) {
      if (isAbortError(error)) {
        // The worker keeps compacting after the client stops watching, so
        // claiming it was cancelled would be a lie about the session.
        ctx.tui.printNotice(
          'Stopped watching the compaction, but it is still running on the Host — the context will change when it finishes.',
        );
        return { kind: 'handled' };
      }
      const code = hostErrorCode(error);
      const refusal = code === undefined ? undefined : COMPACTION_REFUSALS[code];
      ctx.tui.printError(
        refusal === undefined
          ? `Compaction failed: ${describeError(error)}`
          : `Compaction refused: ${refusal}`,
      );
      return { kind: 'handled' };
    }

    if (terminal === 'completed') {
      // The transcript on screen is the pre-compaction one, so it is
      // re-read. This is not `adoptSession`: the session did not change,
      // and a "switched to ..." notice would be a lie.
      const actions = ctx.actions;
      if (actions === undefined) {
        ctx.tui.printNotice('Compacted, but this surface cannot repaint the transcript.');
      } else {
        try {
          await actions.reloadTranscript(ctx.session.id);
        } catch (error) {
          ctx.tui.printError(`Could not reload the transcript: ${describeError(error)}`);
        }
      }
    } else if (terminal === null) {
      ctx.tui.printError(
        'The Host closed the compaction stream without a result — the compaction may still be running.',
      );
    }
    return { kind: 'handled' };
  },
};

export const COMPACT_COMMANDS: readonly TuiSlashCommandDef[] = [COMPACT_COMMAND];

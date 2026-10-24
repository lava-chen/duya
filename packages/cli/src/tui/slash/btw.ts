/**
 * packages/cli/src/tui/slash/btw.ts
 *
 * `/btw [question]` — ask a side question without interrupting the turn.
 *
 * ## Why this one runs WHILE a turn streams
 *
 * The catalog marks `btw` as safe while busy, and that is the whole
 * point of the command: the interesting moment to ask "what is the
 * difference between these two APIs?" is while the agent is working on
 * something else. The side call is a one-shot model call that never
 * touches the durable transcript, so it neither interrupts the running
 * turn nor queues behind it.
 *
 * The inverse of the catalog's rule is why `/compact` refuses while busy:
 * compaction rewrites the context the running turn is reading from, and
 * a side question touches nothing.
 *
 * ## The question is asked when it is missing
 *
 * A side question without a question is not a side question, so bare
 * `/btw` opens the TUI's text prompt — the same mechanism `/rename`
 * uses. A surface with no prompt (a test harness, a non-interactive
 * host) is told the usage instead of sending an empty question to the
 * model.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError } from './shared.js';

const BTW_COMMAND: TuiSlashCommandDef = {
  name: 'btw',
  argsHint: '[question]',
  description: 'Ask a side question without interrupting the turn',
  group: 'Session ops',
  async run(ctx: TuiSlashContext, args: string) {
    // A side question is asked about a conversation, so it needs one.
    const sessionId = typeof ctx.session?.id === 'string' ? ctx.session.id.trim() : '';
    if (sessionId === '') {
      ctx.tui.printError('A side question needs a session — open one first.');
      return { kind: 'handled' };
    }

    const typed = args.trim();
    let question = typed;
    if (question === '') {
      const prompted = await ctx.tui.promptText?.('Ask a side question', {
        placeholder: 'Ask without interrupting the running turn',
      }) ?? null;
      if (prompted === null) {
        if (ctx.tui.promptText === undefined) {
          ctx.tui.printError('Usage: /btw <question>');
        }
        return { kind: 'handled' };
      }
      question = prompted.trim();
      if (question === '') {
        ctx.tui.printError('A side question cannot be empty.');
        return { kind: 'handled' };
      }
    }

    try {
      const result = await ctx.client.askSideQuestion(sessionId, question);
      const answer = typeof result?.answer === 'string' ? result.answer : '';
      if (answer.trim() === '') {
        ctx.tui.printNotice('The side question came back empty.');
        return { kind: 'handled' };
      }
      ctx.tui.printNotice('Side answer:');
      // One notice per line: a multi-line answer in a single notice would
      // be rendered as one long line.
      for (const line of answer.split(/\r?\n/u)) ctx.tui.printNotice(line);
    } catch (error) {
      ctx.tui.printError(`Side question failed: ${describeError(error)}`);
    }
    return { kind: 'handled' };
  },
};

export const BTW_COMMANDS: readonly TuiSlashCommandDef[] = [BTW_COMMAND];

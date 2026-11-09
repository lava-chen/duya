/**
 * Give a CHILD session the persistence it needs to be resumable.
 *
 * ## Why a child needs its own journal
 *
 * `WorkerSession._commitDurable` writes through `this.journal`, and the
 * journal is the ONLY channel into `messageDb`. A child session built by the
 * sub-agent factory had no journal, so every message it produced stayed in
 * its in-memory timeline and died with the process.
 *
 * That is why `resume_from` could not find a sub-agent's history: the
 * history was never written. The resume lookup itself was correct — it reads
 * `messageDb` by session id — the reader was pointed at an empty table.
 *
 * The parent's journal cannot cover this: `message_index` is keyed by
 * session, and a child is a DIFFERENT session with its own row.
 *
 * ## Why the rule lives here and not at each call site
 *
 * Two composition points build a child session — the sub-agent factory in
 * `worker-session-runtime.ts` and the workflow binding in
 * `worker-workflows/execution-binding.ts`. A rule stated twice is a rule that
 * one of them will forget, and a child without a journal fails SILENTLY: it
 * runs fine and its history simply is not there.
 *
 * ## Why this module takes the shape and not the session
 *
 * It takes a `{ journal }` carrier rather than a `WorkerSession`, so it does
 * not import the runtime back. A module that both the runtime and the
 * workflow binding import, and which itself imports the runtime, is a cycle
 * waiting for the next edit.
 */

import { Journal } from './Journal.js';
import { logger } from '../worker-logger.js';

/** The one member this module needs from a session. */
export interface JournalCarrier {
  journal: Journal | undefined;
}

/**
 * Attach a {@link Journal} to a child session.
 *
 * A session with no id gets no journal: there is no key to write under, and
 * a journal pointed at an empty session id would write rows that no reader
 * can find — the same empty history, one step further away.
 */
export function attachChildJournal<T extends JournalCarrier>(session: T, sessionId: string | undefined): T {
  if (!sessionId) return session;
  // Never replace an existing journal: the top-level session attaches its
  // own right after construction, and a second one would be a second writer
  // for the same rows.
  if (session.journal) return session;
  session.journal = new Journal({
    sessionId,
    onError: (kind, err) => {
      logger.warn(
        `[SubAgent] journal ${kind} persist failed`,
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        'SubAgent',
      );
    },
  });
  return session;
}

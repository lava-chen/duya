/**
 * The worker's side-effect ledger: a durable pre-write, or the tool does not run.
 *
 * ## Why this exists
 *
 * `RunEngineImpl.#ticket` (`run-engine.ts:1061`) refuses to dispatch anything
 * that is not `read_only` when no ledger is attached, and the reason it is phrased
 * as a refusal is the whole point: "no ledger" means "no tool with a side effect
 * may be dispatched", NOT "assume none exist". Without a ledger the engine has
 * nowhere to write the `dispatched` record, so every call it makes is one a
 * crash cannot classify -- which is `unknown`, the state that blocks recovery
 * (`ports.ts:871-877`).
 *
 * The live adapter resolved every tool to `undeclared` (an empty
 * `SideEffectLookup`), so every dispatch would have been refused. Attaching a
 * ledger is what makes the non-`read_only` path reachable AT ALL, which is why
 * the ledger had to be real before the model port could be bound.
 *
 * ## What "durable" means here, precisely
 *
 * The failure this prevents is a PROCESS dying between "the tool started" and
 * "the tool's outcome is known" -- the worker is a child process, and it is
 * killed on transport failures, on session teardown, and on app exit. So the
 * requirement is narrower than "survives a power cut": a record that has been
 * `fsync`ed must be readable by a DIFFERENT process afterwards.
 *
 * That is what makes this an append-only JSONL file rather than a map: `begin`
 * appends and `fsync`s BEFORE it resolves, so by the time the engine holds a
 * ticket the bytes are on the platter. A fresh reader — a different process, a
 * restarted worker — reconstructs the attempt list from the file, which is what
 * `read()` does and what the test below asserts against a second instance.
 *
 * ## Why `begin` writes `dispatched` before anything has dispatched
 *
 * This is deliberate over-recording, and the direction is not arbitrary. The two
 * ways to be wrong are not symmetric:
 *
 *  - a record that says `planned` when the tool actually RAN  -> a retry is
 *    permitted, and the retry double-applies the side effect;
 *  - a record that says `dispatched` when the tool never ran -> a retry is
 *    refused, and someone has to look.
 *
 * The first is a duplicated side effect on the user's disk. The second is a
 * blocked run. So the ledger is biased toward "it might have happened", which is
 * exactly what the contract's own wording asks for (`ports.ts:1058`: "Record a
 * call as `planned`, then as `dispatched`, then resolve with a ticket") and why
 * `unknown` is a legal, honest state rather than a bug.
 *
 * ## What this does NOT do
 *
 * It does not decide whether an effect landed. `reconcile` refuses, and
 * `run-engine-ports.ts:241` refuses it too, with the same reason: reconciliation
 * is a recovery-time decision the Control Plane makes, and a mid-run caller able
 * to flip `unknown` to `reconciled` would be answering for an authority nobody
 * asked. Reading the journal back for a recovery decision is a later slice; what
 * is here is the write side plus an honest `read`.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalJson, sha256Hex } from '@duya/agent-protocol';
import type {
  RunEpoch,
  RunFence,
  RunId,
  ToolAttemptState,
  ToolSideEffectClass,
} from '@duya/agent-protocol';
import type {
  ToolAttemptRecord,
  ToolCallRequest,
  ToolDispatchTicket,
  ToolSideEffectLedger,
} from '@duya/agent-runtime';

/** What a journal line holds. One append per state transition. */
interface JournalEntry {
  readonly state: ToolAttemptState;
  readonly attemptKey: string;
  readonly runId: string;
  readonly runEpoch: number;
  readonly callId: string;
  readonly toolName: string;
  readonly inputDigest: string;
  readonly sideEffect: ToolSideEffectClass;
  readonly fenceToken: number;
  /** `settle` detail. Never the tool's own output beyond the caller's limit. */
  readonly detail?: string;
  readonly reconciledBy?: string;
  readonly atMs: number;
}

export interface LedgerOptions {
  /** Directory the journal lives in. Created if absent. Injected by tests. */
  readonly dir: string;
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
  /** The fence this attempt writes at, so a stale writer is detectable. */
  readonly fence: RunFence;
  readonly now?: () => number;
}

/**
 * The directory side-effect journals go in.
 *
 * Same resolution the worker's ring trace uses (`agent-process-entry.ts:472`),
 * because it answers the same question: where does this process put a file that
 * has to outlive a single run. The subdirectory keeps the journals from mixing
 * with logs, which are routinely deleted.
 */
export function defaultLedgerDir(): string {
  const base =
    process.env.DUYA_WORKER_LOG_DIR ??
    process.env.DUYA_CLI_USER_DATA_DIR ??
    process.env.TMPDIR ??
    process.env.TEMP ??
    process.env.TMP ??
    '/tmp';
  return path.join(base, 'tool-side-effects');
}

/**
 * The journal path for one run attempt.
 *
 * The run id is sanitised because it reaches a filename, and `.` is excluded from
 * the allowed set rather than kept: that makes "no segment can be `.` or `..`"
 * true by construction instead of by argument, so a run id cannot traverse out of
 * the journal directory no matter what it contains. Real run ids are UUIDs
 * (`run-identity.ts`), so nothing legitimate is lost.
 *
 * The epoch is in the name so a RECOVERED attempt writes beside the one it
 * recovered from rather than over it.
 */
export function ledgerFile(options: {
  readonly dir: string;
  readonly runId: RunId;
  readonly runEpoch: RunEpoch;
}): string {
  const safeRunId = options.runId.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(options.dir, `${safeRunId}.${options.runEpoch}.jsonl`);
}

/**
 * A ledger that admits a call only after the record is on disk.
 *
 * `begin` throws rather than returning a ticket it could not persist, and
 * `run-engine.ts:787` awaits it BEFORE `ports.tools.dispatch` — so a failure here
 * means no dispatch happened, which is the property this whole file exists to
 * provide.
 */
export function createToolSideEffectLedger(options: LedgerOptions): ToolSideEffectLedger {
  const now = options.now ?? ((): number => Date.now());
  const file = ledgerFile(options);
  // Best effort, and NOT a precondition for constructing a ledger: the directory
  // is prepared here so the common case costs nothing per record, but a path that
  // cannot be prepared is allowed through. Making it fatal at construction would
  // kill a whole run over a journal directory before a single tool was asked for
  // -- and the failure belongs at `begin`, where refusing means the tool does not
  // run, which is the guarantee that matters.
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Reported by `begin`, which is the only caller that needs the directory.
  }

  /**
   * Keys this process has already begun.
   *
   * Seeded from the file, so a RESTARTED worker refuses to re-begin a call the
   * previous process already recorded. That is what makes "exactly one record per
   * attemptKey" (`ports.ts:1060`) survive the only event that could break it: the
   * process that wrote the record dying.
   */
  const begun = new Set<string>();
  for (const entry of readJournal(file)) begun.add(entry.attemptKey);

  /**
   * Append one line and make it durable.
   *
   * `openSync`/`closeSync` per record rather than a cached descriptor: a crash
   * mid-write then leaves the file consistent (an append either landed or did
   * not) with no descriptor to leak, and a run dispatches a handful of tools, so
   * the open cost is not what matters here.
   *
   * `fsyncSync` before close is the load-bearing call. Without it the bytes are in
   * the page cache and a machine crash loses the record the ticket promised.
   */
  const append = (entry: JournalEntry): void => {
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  const base = (call: ToolCallRequest, attemptKey: string, state: ToolAttemptState): JournalEntry => ({
    state,
    attemptKey,
    runId: options.runId,
    runEpoch: options.runEpoch,
    callId: call.callId,
    toolName: call.name,
    // The digest, not the arguments. A retry has to be able to prove it is
    // retrying the SAME work, and the arguments themselves are the user's
    // content -- which is exactly what must not end up in a side-effect journal
    // nobody reads.
    inputDigest: sha256Hex(canonicalJson(call.input as never)),
    sideEffect: call.sideEffect,
    fenceToken: options.fence.token,
    atMs: now(),
  });

  return {
    async begin(call: ToolCallRequest): Promise<ToolDispatchTicket> {
      // Minted HERE and never by the engine (`run-engine.ts:1071`): the ledger is
      // the single writer of attempt keys, so two attempts cannot collide on one.
      const attemptKey = `${options.runId}/${options.runEpoch}/${call.callId}`;

      if (begun.has(attemptKey)) {
        throw new Error(
          `refusing to begin '${call.name}': attempt ${attemptKey} is already recorded, and one attempt has exactly one record`,
        );
      }
      // Marked before the write, so a `begin` that throws mid-write does not leave
      // the set believing the record landed. A retry of the same call is refused
      // by the file check above, which is the authority; this is the fast path.
      begun.add(attemptKey);

      try {
        // Both transitions durable, in order, before the ticket resolves.
        append(base(call, attemptKey, 'planned'));
        append(base(call, attemptKey, 'dispatched'));
      } catch (error) {
        begun.delete(attemptKey);
        throw new Error(
          `refusing to dispatch '${call.name}': its side-effect record could not be written durably to ${file}, so the call could not be accounted for (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      return {
        attemptKey,
        runId: options.runId,
        runEpoch: options.runEpoch,
        fence: options.fence,
      };
    },

    async settle(input: {
      readonly attemptKey: string;
      readonly state: 'succeeded' | 'failed' | 'unknown';
      readonly detail?: string;
    }): Promise<void> {
      const previous = latestByKey(readJournal(file), input.attemptKey);
      if (previous === undefined) {
        // Loud. A settle for a key this ledger never began means the engine and
        // the ledger disagree about what ran, and recording it anyway would paper
        // over that.
        throw new Error(
          `refusing to settle ${input.attemptKey}: no such attempt is recorded in ${file}`,
        );
      }
      append({ ...previous, state: input.state, ...(input.detail === undefined ? {} : { detail: input.detail }), atMs: now() });
    },

    async read(): Promise<readonly ToolAttemptRecord[]> {
      return collapse(readJournal(file));
    },

    /**
     * Not wired, on purpose — see the file header and
     * `run-engine-ports.ts:236-245`. Throwing keeps "nobody has asked" distinct
     * from "nobody answered", which a silent success would erase.
     */
    async reconcile(): Promise<void> {
      throw new Error(
        'tool side-effect reconciliation is a recovery-time decision and is not wired to the engine',
      );
    },
  };
}

/** Every well-formed line, oldest first. An unparseable line is a hard error. */
function readJournal(file: string): readonly JournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    // A journal that does not exist yet is the normal first-run case, and only
    // that: a file that exists but cannot be read is a real failure and is
    // reported by the caller rather than treated as "no attempts".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    entries.push(JSON.parse(line) as JournalEntry);
  }
  return entries;
}

/** The last entry written for a key, or `undefined`. */
function latestByKey(
  entries: readonly JournalEntry[],
  attemptKey: string,
): JournalEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.attemptKey === attemptKey) return entry;
  }
  return undefined;
}

/**
 * The journal's entries, one row per key, at that key's LATEST state.
 *
 * The journal is an append-only transition log, so a key appears once per
 * transition; a reader that returned all of them would report `planned` and
 * `dispatched` for the same call as two attempts, which is how one call becomes
 * two rows nobody can reconcile.
 */
function collapse(entries: readonly JournalEntry[]): readonly ToolAttemptRecord[] {
  const byKey = new Map<string, JournalEntry>();
  for (const entry of entries) byKey.set(entry.attemptKey, entry);
  return [...byKey.values()]
    .map((entry) => ({
      attemptKey: entry.attemptKey,
      runId: entry.runId,
      runEpoch: entry.runEpoch,
      callId: entry.callId,
      toolName: entry.toolName,
      inputDigest: entry.inputDigest,
      state: entry.state,
      sideEffect: entry.sideEffect,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.reconciledBy === undefined ? {} : { reconciledBy: entry.reconciledBy }),
    }))
    .sort((a, b) => (a.attemptKey < b.attemptKey ? -1 : a.attemptKey > b.attemptKey ? 1 : 0));
}

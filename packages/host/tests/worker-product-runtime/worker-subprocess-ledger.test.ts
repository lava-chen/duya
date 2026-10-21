/**
 * Plan 610 S1: does a REAL PROCESS's stdout reach the Host's ledger?
 *
 * ## The gap this closes
 *
 * Every other proof of the native channel drove `driveRunWithEngine`
 * IN-PROCESS. That is a real driver, a real engine, a real store — and it
 * leaves the one seam nobody had exercised: the bytes. A `run:event` envelope
 * that the worker writes to `process.stdout` has to survive a pipe, one JSON
 * object per line, and come out the other side as the same envelope. In-process
 * delivery cannot fail at that, because there is no pipe to fail at.
 *
 * So this file spawns a child, writes the wire format to its stdout, and reads
 * that stdout exactly the way production reads it — one line at a time, split
 * on `\n`, JSON-parsed, with the `_logger` marker and the escaped newlines
 * `sendEvent` adds.
 *
 * ## What is REAL here, stated precisely
 *
 * Real: the child process, its stdout pipe, the OS delivering the bytes in
 * whatever chunk sizes it chooses, the line framing, the JSON decode, the Host
 * wire validation, `RunOrchestrator.persistNativeRunEvent`, and a real
 * SQLite `RunStore` with the real migrations.
 *
 * NOT real — and this is the honest limit of the file: the CHILD does not run
 * the worker's own `sendEvent`. `worker-process-entry.ts` calls `main()` at
 * import, so it cannot be imported as a module, and its emit site
 * (`worker-process-entry.ts:2341`) is not reachable without booting a session.
 * The child therefore emits the wire format through a copy of
 * `worker-transport.ts:92-102`'s framing (minus the backpressure queue, which is
 * irrelevant for a burst this small).
 *
 * **What that means:** this file proves the WIRE and the RECEIVE path — that a
 * `run:event` line produced the way the worker produces one is read by a host
 * the way a host reads one, and lands in the ledger under the Runtime's own
 * `seq`. It does NOT prove that the worker's emit code still produces that
 * format. A regression inside `worker-process-entry.ts`'s `sendEvent` call
 * would not turn this file red; it would be caught by whatever asserts on the
 * worker's own frames, which is the complement of this file, not this file.
 *
 * ## The validation, and why it is REPLICATED rather than called
 *
 * `HostRunExecutionController.#acceptNativeRunEvent` (`run-execution.ts:446`)
 * is a private method reached only through `#onWorkerMessage`, and spinning the
 * whole controller means spawning a real worker binary — which is the thing
 * this file cannot do. So the five wire-boundary ACCEPT conditions are
 * replicated below, verbatim in behaviour and named in comments, and each
 * rejection is asserted to leave the ledger untouched. That is a copy of a
 * contract, not a call into it: if the production switch changes, this file
 * does NOT follow it, and that is stated rather than hidden.
 */

import Database from 'better-sqlite3';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '@duya/agent-protocol';

const { RunOrchestrator, createWorkerExecutionChannel } = await import('@duya/host/run-orchestrator');
const { writeRunReceiptOnWire } = await import('@duya/host/run-receipt');
const { RunStore, RUN_STORE_MIGRATIONS, RunEpochFencedError, RunEventConflictError } = await import(
  '@duya/data/run-store'
);

const SESSION_ID = 's-stdout-ledger';
const CHILD_TIMEOUT_MS = 10_000;

/**
 * The child's source.
 *
 * `sendEvent` copied from `worker-transport.ts:92-102`: JSON-encode, append the
 * `_logger` marker, escape embedded newlines, terminate with `\n`. The ONLY
 * thing left out is the bounded write queue, which exists to survive a stalled
 * consumer — a pipe that a test reads to completion is never stalled, and a
 * test of a queue belongs to a suite about the queue.
 */
const CHILD_SOURCE = `
function sendEvent(event) {
  let payload = JSON.stringify(Object.assign({}, event, { _logger: 'worker' }));
  if (payload.includes('\\n')) payload = payload.replace(/\\n/g, '\\\\n');
  process.stdout.write(payload + '\\n');
}
const frames = JSON.parse(process.argv[1]);
for (const frame of frames) sendEvent(frame);
`;

const liveChildren: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

function trackTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  // A leaked child outlives the suite and holds the pipe open, so this does not
  // merely tidy up: it fails loudly rather than leaving a process behind.
  for (const child of liveChildren.splice(0)) {
    if (child.exitCode !== null || child.killed) continue;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    const raced = await Promise.race([
      closed.then(() => 'closed' as const),
      new Promise<'leaked'>((resolve) => setTimeout(() => resolve('leaked'), 2_000)),
    ]);
    if (raced === 'leaked') throw new Error(`worker child ${child.pid} survived kill; the suite leaked a process`);
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

/** One `run:event` wire frame, exactly as the worker emits it. */
interface WireFrame {
  readonly type: string;
  readonly epoch: unknown;
  readonly envelope: unknown;
}

interface Received {
  readonly frames: number;
  readonly lines: readonly string[];
  readonly verdicts: readonly { readonly accepted: boolean; readonly reason: string }[];
  readonly refusals: readonly string[];
}

/**
 * Read a real child's stdout and feed every line through the receive path.
 *
 * The line handling is `router.ts:1626-1660`'s: accumulate, split on `\n`,
 * keep the tail, and JSON-parse what starts with `{`. `readline` is used rather
 * than a hand-rolled splitter because it is the same primitive the worker's own
 * `parseStdin` uses, and it handles the `crlfDelay` case a Windows pipe can
 * produce.
 */
async function pump(
  frames: readonly WireFrame[],
  opts: { readonly runId: string; readonly store: RunStore; readonly orchestrator: InstanceType<typeof RunOrchestrator> },
): Promise<Received> {
  const child = spawn(process.execPath, ['-e', CHILD_SOURCE, JSON.stringify(frames)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  liveChildren.push(child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const lines: string[] = [];
  const verdicts: Array<{ accepted: boolean; reason: string }> = [];
  const refusals: string[] = [];

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    lines.push(trimmed);
    let parsed: WireFrame;
    try {
      parsed = JSON.parse(trimmed) as WireFrame;
    } catch {
      refusals.push('not json');
      continue;
    }
    if (typeof parsed.type !== 'string' || parsed.type !== 'run:event') {
      refusals.push(`type ${String(parsed.type)} is not run:event`);
      continue;
    }
    const verdict = await acceptNativeRunEvent(SESSION_ID, parsed, opts);
    verdicts.push(verdict);
    if (!verdict.accepted) refusals.push(verdict.reason);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit; stderr: ${stderr}`)), CHILD_TIMEOUT_MS);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (stderr.trim() !== '') throw new Error(`child wrote to stderr: ${stderr}`);

  return { frames: frames.length, lines, verdicts, refusals };
}

/**
 * The Host's `run:event` wire validation, REPLICATED from
 * `run-execution.ts:446-491`.
 *
 * Every condition below is a WIRE check on untrusted process output, and every
 * one of them is a refusal rather than a throw. They are copied here rather than
 * called because the production method is private and reachable only through a
 * full controller — see the module doc. `persistNativeRunEvent` IS the real one.
 */
async function acceptNativeRunEvent(
  sessionId: string,
  msg: WireFrame,
  opts: { readonly runId: string; readonly store: RunStore; readonly orchestrator: InstanceType<typeof RunOrchestrator> },
): Promise<{ accepted: boolean; reason: string }> {
  const epoch = msg.epoch;
  // An `epoch` that is not a finite integer has no attempt to fence against.
  if (typeof epoch !== 'number' || !Number.isFinite(epoch) || !Number.isInteger(epoch)) {
    return { accepted: false, reason: `dropped a native run:event with no finite integer attempt (epoch=${String(epoch)})` };
  }
  const envelope = msg.envelope;
  if (!isRecord(envelope)) {
    return { accepted: false, reason: 'dropped a native run:event with no envelope object' };
  }
  const runId = envelope['runId'];
  if (typeof runId !== 'string' || runId === '') {
    return { accepted: false, reason: 'dropped a native run:event with no runId' };
  }
  const seq = envelope['seq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    return { accepted: false, reason: `dropped a native run:event whose seq is not a safe integer >= 1 (seq=${String(seq)})` };
  }
  const payload = envelope['payload'];
  if (!isRecord(payload) || typeof payload['type'] !== 'string') {
    return { accepted: false, reason: `dropped a native run:event with no typed payload (seq=${seq})` };
  }
  // One layer down: the session→run binding, the writer, the fence.
  const verdict = await opts.orchestrator.persistNativeRunEvent(
    sessionId,
    envelope as unknown as RunEventEnvelope,
    epoch,
  );
  if (verdict.accepted) return { accepted: true, reason: '' };
  return { accepted: false, reason: verdict.reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Harness {
  readonly store: RunStore;
  readonly orchestrator: InstanceType<typeof RunOrchestrator>;
  readonly runId: string;
  readonly close: () => void;
}

/** A live run in a real temp database, bound to the session the frames name. */
async function openHarness(): Promise<Harness> {
  const dbDir = trackTempDir('duya-s1-stdout-');
  const db = new Database(join(dbDir, 'core.db'));
  for (const migration of [...RUN_STORE_MIGRATIONS].sort((a, b) => a.id - b.id)) {
    migration.up(db);
  }
  const store = new RunStore(db);

  const dbRequest = async (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    if (action === 'run:create') {
      const outcome = store.createRun(payload as unknown as Parameters<RunStore['createRun']>[0]);
      if (outcome.state === 'created') return writeRunReceiptOnWire({ state: 'created', runId: outcome.runId });
      if (outcome.state === 'reused') return writeRunReceiptOnWire({ state: 'reused', runId: outcome.runId });
      return writeRunReceiptOnWire({ state: 'conflict', runId: outcome.runId, reason: outcome.reason });
    }
    if (action === 'run:complete') {
      const { runId, terminal } = payload as { runId: string; terminal: unknown };
      const outcome = store.settleRun(runId, terminal as never);
      return outcome.state === 'applied'
        ? writeRunReceiptOnWire({ state: 'applied', runId })
        : writeRunReceiptOnWire({ state: 'conflict', runId, reason: outcome.state });
    }
    return writeRunReceiptOnWire({ state: 'invalid', runId: '', reason: `unhandled action ${action}` });
  };

  const orchestrator = new RunOrchestrator({
    nativeWriter: {
      currentEpoch: (runId: string) => store.currentEpoch(runId),
      append: (runId: string, envelopes: readonly RunEventEnvelope[], epoch: number) => {
        try {
          const written = store.appendEvents(envelopes, epoch);
          return written === 0 ? { state: 'duplicate' } : { state: 'written', written };
        } catch (error) {
          if (error instanceof RunEpochFencedError) {
            return { state: 'fenced', presented: error.presented, current: store.currentEpoch(runId) ?? 0 };
          }
          return { state: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
    dbRequest: dbRequest as never,
    channel: createWorkerExecutionChannel({
      dispatch: () => true,
      interrupt: () => ({ accepted: true, settled: Promise.resolve('cooperative' as const) }),
    } as never),
  });

  const workspaceDir = trackTempDir('duya-s1-stdout-ws-');
  // `openRun` binds the session to the run, which is what makes every later
  // run-identity check a real one instead of a lookup that always misses.
  const opened = await orchestrator.openRun(SESSION_ID, {
    prompt: 'stdout ledger proof',
    options: { sessionId: SESSION_ID },
    model: 'claude-test',
    providerId: 'anthropic',
    workingDirectory: workspaceDir,
  } as never);
  if (!opened.accepted) throw new Error(`the harness run did not open: ${JSON.stringify(opened)}`);
  const runId = opened.runId;

  return {
    store,
    orchestrator,
    runId,
    close: () => db.close(),
  };
}

function event(runId: string, seq: number, type: string, payload: Record<string, unknown> = {}): WireFrame {
  return {
    type: 'run:event',
    epoch: 0,
    envelope: { runId, sessionId: SESSION_ID, seq, payload: { type, ...payload } },
  };
}

describe('plan-610 S1 — a real process stdout reaches the real ledger', () => {
  it('every durable run:event line lands under the seq the Runtime minted', async () => {
    const harness = await openHarness();
    try {
      const frames: readonly WireFrame[] = [
        event(harness.runId, 1, 'run.started'),
        event(harness.runId, 2, 'turn.started'),
        event(harness.runId, 3, 'assistant.text_block', { text: 'from a real pipe' }),
        // An ephemeral type: accepted, deliberately NOT stored.
        event(harness.runId, 4, 'assistant.text_delta', { text: 'a' }),
        event(harness.runId, 5, 'assistant.message_finalized'),
        event(harness.runId, 6, 'run.completed'),
      ];

      const received = await pump(frames, harness);

      // The pipe really carried one line per frame, and every line carries the
      // `_logger` marker `sendEvent` appends — so the host read the worker's
      // framing rather than a shape it invented.
      expect(received.lines).toHaveLength(frames.length);
      expect(received.lines.every((line) => line.includes('"_logger":"worker"'))).toBe(true);
      expect(received.verdicts.filter((verdict) => verdict.accepted)).toHaveLength(frames.length);
      expect(received.refusals).toEqual([]);

      // The ledger holds the Runtime's own identities, holes included. Seq 4 is
      // `ephemeral` and is absent BY DESIGN, so the stored list is 1,2,3,5,6 —
      // which is exactly what makes the equality below a real claim about the
      // Runtime's numbering rather than a renumbered 1..5.
      const stored = harness.store.listEvents(harness.runId, 0);
      expect(stored.map((row) => row.seq)).toEqual([1, 2, 3, 5, 6]);
      expect(stored.map((row) => row.event_type)).toEqual([
        'run.started',
        'turn.started',
        'assistant.text_block',
        'assistant.message_finalized',
        'run.completed',
      ]);
      expect(stored.every((row) => row.epoch === 0)).toBe(true);
      expect(stored.every((row) => row.run_id === harness.runId)).toBe(true);
    } finally {
      harness.close();
    }
  });

  it('an envelope carrying a newline survives the wire intact', async () => {
    const harness = await openHarness();
    try {
      // `sendEvent` escapes embedded newlines precisely so one frame cannot be
      // read as two lines. A payload with two of them is the case that escaping
      // exists for, and it has to come back as ONE row with its text intact.
      const text = 'first line\nsecond line\n\nfourth';
      const received = await pump([event(harness.runId, 1, 'assistant.message_finalized', { text })], harness);

      expect(received.lines).toHaveLength(1);
      expect(received.verdicts[0]?.accepted).toBe(true);

      const stored = harness.store.listEvents(harness.runId, 0);
      expect(stored).toHaveLength(1);
      const envelope = JSON.parse(stored[0]?.envelope_json ?? '{}') as RunEventEnvelope;
      expect((envelope.payload as { text: string }).text).toBe(text);
      expect(((envelope.payload as { text: string }).text.match(/\n/g) ?? [])).toHaveLength(3);
    } finally {
      harness.close();
    }
  });

  it('malformed and foreign frames are refused and leave the ledger untouched', async () => {
    const harness = await openHarness();
    try {
      const good = event(harness.runId, 1, 'turn.started');
      const frames: readonly WireFrame[] = [
        good,
        // A fractional attempt: there is no attempt to fence against.
        { type: 'run:event', epoch: 1.5, envelope: { runId: harness.runId, seq: 2, payload: { type: 'turn.ended' } } },
        // Seq 0 is not an identity.
        { type: 'run:event', epoch: 0, envelope: { runId: harness.runId, seq: 0, payload: { type: 'turn.ended' } } },
        // No typed payload.
        { type: 'run:event', epoch: 0, envelope: { runId: harness.runId, seq: 3, payload: 'not an object' } },
        // A live process naming a run this session is not executing.
        event('some-other-run', 4, 'turn.ended'),
        // Not the native channel at all.
        { type: 'chat:text', epoch: 0, envelope: { runId: harness.runId, seq: 5, payload: { type: 'turn.ended' } } },
      ];

      const received = await pump(frames, harness);
      const before = harness.store.listEvents(harness.runId, 0).map((row) => row.seq);

      expect(received.lines).toHaveLength(frames.length);
      expect(received.verdicts.filter((verdict) => verdict.accepted)).toHaveLength(1);
      expect(received.verdicts[0]?.accepted).toBe(true);
      // Five refusals, each naming its own reason: a gate that cannot say WHY it
      // refused is how a wire bug becomes an unattributable data loss.
      expect(received.refusals).toHaveLength(5);
      expect(received.refusals.filter((reason) => reason.includes('finite integer attempt'))).toHaveLength(1);
      expect(received.refusals.filter((reason) => reason.includes('safe integer >= 1'))).toHaveLength(1);
      expect(received.refusals.filter((reason) => reason.includes('typed payload'))).toHaveLength(1);
      expect(received.refusals.filter((reason) => reason.includes('not run:event'))).toHaveLength(1);
      expect(received.refusals.filter((reason) => reason.includes('is executing run'))).toHaveLength(1);

      // And the ledger proves it: exactly the one good row, unchanged.
      expect(harness.store.listEvents(harness.runId, 0).map((row) => row.seq)).toEqual(before);
      expect(before).toEqual([1]);
    } finally {
      harness.close();
    }
  });

  it('a re-delivered line is a no-op, not a second row', async () => {
    const harness = await openHarness();
    try {
      const frames: readonly WireFrame[] = [
        event(harness.runId, 1, 'run.started'),
        event(harness.runId, 2, 'turn.started'),
      ];
      await pump(frames, harness);
      const first = harness.store.listEvents(harness.runId, 0).map((row) => `${row.event_type}#${row.seq}`);

      // An at-least-once pipe does this routinely, and the sequence numbers
      // here are not consecutive, so a Host that renumbered would show it.
      const again = await pump(frames, harness);

      expect(again.verdicts.every((verdict) => verdict.accepted)).toBe(true);
      expect(again.refusals).toEqual([]);
      expect(harness.store.listEvents(harness.runId, 0).map((row) => `${row.event_type}#${row.seq}`)).toEqual(first);
      expect(harness.store.countEvents(harness.runId)).toBe(2);
    } finally {
      harness.close();
    }
  });
});

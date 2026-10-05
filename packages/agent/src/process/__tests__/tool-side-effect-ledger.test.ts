/**
 * Plan 600 S2 (inversion step 2) -- the side-effect ledger admits a tool only
 * after a durable pre-write.
 *
 * ## What this pins
 *
 * `RunEngineImpl.#ticket` (`run-engine.ts:1061`) refuses to dispatch anything that
 * is not `read_only` when no ledger is attached, and it awaits
 * `ledger.begin(call)` BEFORE `ports.tools.dispatch` (`run-engine.ts:787,557`).
 * That ordering is the whole guarantee: a dispatch is unreachable without a
 * record, so a process that dies mid-tool leaves an attempt somebody can
 * classify rather than an effect nobody recorded.
 *
 * The three ways this could be theatre, and the test for each:
 *
 *  1. **The record is not on disk.** A ledger that keeps attempts in a Map is
 *     admissible in-process and worthless across the process death it exists for.
 *     "the record is ON DISK" reads the journal back through a SECOND ledger
 *     instance — a different object with its own empty map — so a Map-backed
 *     ledger fails it.
 *  2. **A failed write is survivable.** If `begin` swallowed a write error and
 *     returned a ticket anyway, the engine would dispatch a tool with no record,
 *     which is the exact state the guard is for. "refuses to admit a call whose
 *     record cannot be written durably" makes the write fail.
 *  3. **The ordering is only true afterwards.** An end-of-run assertion that the
 *     journal is non-empty passes even for an engine that dispatched first and
 *     recorded second. The `describe` block at the bottom drives the REAL
 *     `RunEngineImpl` and reads the file from INSIDE `ToolPort.dispatch`, so the
 *     claim under test is the interleaving rather than the end state.
 *
 * ## Why these are not `a === a`
 *
 * Each assertion's two sides come from different sources: the writer's
 * in-memory view against a fresh reader's view of the FILE; the journal's line
 * count against the API's own refusal; the engine's recorded dispatches against
 * the journal read at the moment of dispatch. A fixture that shared state with
 * the code under test would pass all of them while proving nothing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ModelFrame,
  RunEnginePorts,
  ToolCallRequest,
  ToolDrainItem,
} from '@duya/agent-runtime';
import { createToolSideEffectLedger, ledgerFile } from '../tool-side-effect-ledger.js';

const RUN_ID: RunId = 'run_ledger_probe';
const CALL: ToolCallRequest = {
  callId: 'call_1',
  name: 'write_file',
  input: { path: 'a.txt', content: 'hello' },
  // NOT `read_only`: that is the whole point of the ledger. A `read_only` call
  // would be admitted by `SYNTHETIC_TICKET` with no ledger at all
  // (`run-engine.ts:1064-1069`) and this file would prove nothing.
  sideEffect: 'writes_files',
};

const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };

let dir: string;

function makeLedger(overrides: Partial<{ dir: string }> = {}) {
  return createToolSideEffectLedger({
    dir: overrides.dir ?? dir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'duya-ledger-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The journal's raw lines for any run. The on-disk truth, not the API's view. */
function journalLinesFor(runId: RunId): readonly unknown[] {
  const file = ledgerFile({ dir, runId, runEpoch: FIRST_EPOCH });
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
}

/** The journal's raw lines. The on-disk truth, not the API's view of it. */
function journalLines(): readonly unknown[] {
  return journalLinesFor(RUN_ID);
}

/** The state of every transition a run has durably recorded, in order. */
function statesOnDisk(runId: RunId): string[] {
  return journalLinesFor(runId).map((line) => (line as { state: string }).state);
}

describe('a dispatch requires a durable side-effect pre-write', () => {
  it('the record is ON DISK, readable by a different ledger instance', async () => {
    const writer = makeLedger();
    const ticket = await writer.begin(CALL);

    // Not `writer.read()`: that could be answering from the same in-memory set
    // the writer built. A second instance over the same file has to parse the
    // bytes, which is what a restarted worker would have to do.
    const freshReader = makeLedger();
    const attempts = await freshReader.read();

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptKey).toBe(ticket.attemptKey);
    expect(attempts[0]?.state).toBe('dispatched');
    expect(attempts[0]?.toolName).toBe('write_file');
    expect(attempts[0]?.sideEffect).toBe('writes_files');
    // The arguments are digested, not stored: a journal nobody reads must not
    // hold the user's file contents.
    expect(attempts[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(journalLines())).not.toContain('hello');
  });

  it('refuses to admit a call whose record cannot be written durably', async () => {
    // The write fails because the parent is a FILE, so the journal's directory
    // cannot be prepared. A `begin` that swallowed this and returned a ticket
    // would let the engine dispatch a tool with no record anywhere -- the precise
    // state `ports.ts:871-877` refuses to allow.
    const fileInTheWay = path.join(dir, 'not-a-dir');
    writeFileSync(fileInTheWay, 'occupied');

    const ledger = makeLedger({ dir: fileInTheWay });

    await expect(ledger.begin(CALL)).rejects.toThrow(/could not be written durably/);
  });

  it('refuses a SECOND begin for the same attemptKey, and does not overwrite', async () => {
    // `ports.ts:1078-1081`: one attempt has exactly one record, and a second begin
    // is a caller bug that must REJECT rather than overwrite -- the record is the
    // one place the effect is accounted for.
    const ledger = makeLedger();
    await ledger.begin(CALL);
    const linesAfterFirst = journalLines().length;

    await expect(ledger.begin(CALL)).rejects.toThrow(/is already recorded/);

    // The refusal wrote nothing. If it had overwritten, the line count would grow
    // and the first record's state would be lost.
    expect(journalLines()).toHaveLength(linesAfterFirst);
  });

  it('refuses a restart that would re-begin an already recorded call', async () => {
    // The case a Map cannot catch: the process that wrote the record dies, and
    // the next process is handed the same run. Its in-memory set is empty, so
    // only the FILE can tell it the call already happened.
    makeLedger().begin(CALL).catch(() => {});

    const afterRestart = makeLedger();
    await expect(afterRestart.begin(CALL)).rejects.toThrow(/is already recorded/);
  });

  it('settles a real attempt, and refuses to settle one that was never begun', async () => {
    const ledger = makeLedger();
    const ticket = await ledger.begin(CALL);

    await ledger.settle({ attemptKey: ticket.attemptKey, state: 'succeeded', detail: 'wrote 5 bytes' });

    const attempts = await makeLedger().read();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.state).toBe('succeeded');
    expect(attempts[0]?.detail).toBe('wrote 5 bytes');

    // One transition per key, not one row per state change: a reader that counted
    // `planned`, `dispatched` and `succeeded` as three attempts would make one
    // call look like three.
    expect(journalLines()).toHaveLength(3);

    // A settle for a key this run never began is the engine and the ledger
    // disagreeing about what ran. Recording it would hide that.
    await expect(
      ledger.settle({ attemptKey: `${RUN_ID}/${FIRST_EPOCH}/never_began`, state: 'succeeded' }),
    ).rejects.toThrow(/no such attempt is recorded/);
  });

  it('retains BOTH transitions durably before the ticket resolves', async () => {
    // `begin` writes `planned` then `dispatched` and only then resolves, because
    // over-recording "it might have run" is the safe direction: a false
    // `planned` permits a retry that double-applies a side effect, while a false
    // `dispatched` only blocks a run. Both lines are on disk by the time the
    // caller has a ticket, not merely the last one.
    const ledger = makeLedger();
    const ticket = await ledger.begin(CALL);

    const states = journalLines().map(
      (line) => (line as { state: string; attemptKey: string }).state,
    );
    expect(states).toEqual(['planned', 'dispatched']);
    // Same key on both: two attempts would be two rows nobody can reconcile.
    const keys = new Set(
      journalLines().map((line) => (line as { attemptKey: string }).attemptKey),
    );
    expect([...keys]).toEqual([ticket.attemptKey]);
  });

  it('keeps the epoch in the filename, so a recovered attempt cannot overwrite it', () => {
    // Stated rather than assumed: two epochs of one run are two journals, which
    // is what makes "the killed attempt's records" readable beside the new one.
    const first = ledgerFile({ dir, runId: RUN_ID, runEpoch: FIRST_EPOCH });
    const second = ledgerFile({ dir, runId: RUN_ID, runEpoch: FIRST_EPOCH + 1 });
    expect(first).not.toBe(second);
  });

  it('sanitizes the run id, so a run id cannot escape the journal directory', () => {
    // The invariant, stated as the filesystem sees it: the result is ONE segment
    // inside `dir`, whatever the run id contained.
    const escaped = ledgerFile({ dir, runId: '../../etc/passwd', runEpoch: FIRST_EPOCH });
    expect(path.dirname(path.resolve(escaped))).toBe(path.resolve(dir));
    expect(path.basename(escaped)).not.toMatch(/[/\\]/);

    // And dots are not preserved, which is what rules out a segment that is `.`
    // or `..`. Checked as an EQUIVALENCE against a second, safe run id rather
    // than by restating the sanitizer's own pattern -- a hostile id of the same
    // length must land on exactly the file a safe one does.
    expect(ledgerFile({ dir, runId: '..', runEpoch: FIRST_EPOCH })).toBe(
      ledgerFile({ dir, runId: '__', runEpoch: FIRST_EPOCH }),
    );
  });
});

// ============================================================================
// The same guarantee, at the level the engine enforces it
// ============================================================================

/**
 * A manifest the real engine will accept.
 *
 * Only the fields the engine reads are asserted on, and `provenance` is filled
 * with `unsupported` rather than omitted because the engine hashes the manifest
 * and a missing provenance is a shape it would refuse for a different reason --
 * which would make a failure here ambiguous.
 */
function probeManifest(runId: RunId): RunManifest {
  const unsupported = { source: 'unsupported', synthesised: true } as const;
  return {
    version: 1,
    runId,
    projectId: null,
    workspaceId: 'test',
    roots: [process.cwd()],
    cwd: process.cwd(),
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: unsupported,
      cwd: unsupported,
      permissionPolicy: unsupported,
      capabilities: unsupported,
      connectorBindings: unsupported,
      env: unsupported,
      agent: unsupported,
      budget: unsupported,
      workspaceId: unsupported,
      deterministic: unsupported,
    },
  };
}

/**
 * Run the real `RunEngineImpl` over a model that asks for exactly one tool.
 *
 * `onDispatch` is the point of the harness: it runs SYNCHRONOUSLY inside
 * `ToolPort.dispatch`, which is the only moment at which "was the record already
 * durable?" is a question about the interleaving rather than about the end state.
 * A test that only checked the journal afterwards would pass even if the engine
 * dispatched first and wrote second.
 */
async function runEngineOverOneTool(options: {
  readonly runId: RunId;
  readonly ledgerDir: string;
  readonly call: ToolCallRequest;
  readonly onDispatch: (call: ToolCallRequest) => void;
}): Promise<void> {
  const queued: ToolDrainItem[] = [];
  const engine = new RunEngineImpl({ now: () => Date.now() });
  const ledger = createToolSideEffectLedger({
    dir: options.ledgerDir,
    runId: options.runId,
    runEpoch: FIRST_EPOCH,
    fence: { runId: options.runId, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token },
  });

  const ports: RunEnginePorts = {
    model: {
      async *stream(): AsyncIterable<ModelFrame> {
        yield { type: 'tool_use', call: options.call };
        yield { type: 'turn_stopped', reason: 'tool_use' };
      },
    },
    tools: {
      dispatch(call: ToolCallRequest): void {
        // Read the FILE at the instant of dispatch.
        options.onDispatch(call);
        queued.push({
          kind: 'tool_result',
          callId: call.callId,
          content: 'wrote the file',
          isError: false,
          durationMs: 1,
        });
      },
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const item of queued.splice(0, queued.length)) yield item;
      },
      discard(): void {
        queued.length = 0;
      },
      describe: () => [],
    },
    context: {
      async assemble() {
        return {
          systemPrompt: 'you are a test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(): void {},
    },
    approval: {
      async authorize() {
        return { allowed: true, scope: 'once' } as const;
      },
    },
    events: {
      publish(): void {},
      proposeTerminal(): void {},
    },
    sideEffects: ledger,
  };

  const handle = engine.execute({
    manifest: probeManifest(options.runId),
    signal: new AbortController().signal,
    ports,
    input: {
      revision: '',
      prompt: { role: 'user', id: 'p1', content: 'write it' },
      history: { kind: 'inline', value: [] },
      attachments: { kind: 'inline', value: [] },
      catalog: { kind: 'by_ref', digest: '', locator: 'catalog://test' },
      steering: [],
      options: {},
    },
  });
  await handle.completed();
}

describe('the real engine cannot dispatch without the record already durable', () => {
  it('has the durable record on disk AT THE MOMENT of dispatch', async () => {
    const runId: RunId = 'run_ordering_probe';
    const seenAtDispatch: string[] = [];

    await runEngineOverOneTool({
      runId,
      ledgerDir: dir,
      call: CALL,
      onDispatch: () => {
        // Read the journal from disk inside `dispatch`. If the engine had
        // dispatched first and recorded second, this would be empty.
        seenAtDispatch.push(...statesOnDisk(runId));
      },
    });

    // Both transitions were already durable when the tool was handed over.
    expect(seenAtDispatch).toEqual(['planned', 'dispatched']);
    // And the run really did dispatch, so the ordering above is not vacuous.
    expect(statesOnDisk(runId)).toContain('dispatched');
  });

  it('dispatches NOTHING when the record cannot be made durable', async () => {
    // The "would fail if the guard were removed" case. A `begin` that swallowed
    // the write failure and returned a ticket anyway would let this dispatch
    // through, and the tool would run with no record of it anywhere.
    const runId: RunId = 'run_unwritable_probe';
    const fileInTheWay = path.join(dir, 'blocked');
    writeFileSync(fileInTheWay, 'occupied');
    let dispatched = 0;

    await runEngineOverOneTool({
      runId,
      // The journal's parent is a FILE, so no write can succeed.
      ledgerDir: fileInTheWay,
      call: CALL,
      onDispatch: () => {
        dispatched += 1;
      },
    });

    expect(dispatched).toBe(0);
  });
});

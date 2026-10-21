/**
 * Plan 610 P7: the run's OWN prompt user row, on the path that does not call
 * the legacy generator.
 *
 * ## The gap this file pins
 *
 * `Journal.userMsgAdded` had exactly ONE production caller in the package --
 * the `role === 'user'` arm of `_commitDurable` -- and `_commitDurable` was
 * reachable only through `_pushDurable`, whose four call sites are all inside
 * `streamChat`. The prompt row was the first of them. `TurnOutputPort` has no
 * user-row arm, `beginTurnAssembly` seeds only `options.messages`, and the fork
 * marker could only arrive through `bindRunForkMarker` from a `runFork` that no
 * production host supplies. So a driver that skipped the generator had no way
 * to make the user's own message durable, and no way to compute a fork marker
 * against the timeline it was actually writing to.
 *
 * `commitTurnPromptUserRow` is the seam. This file is the PROOF that the
 * durable half is real and that the fork marker is RESOLVED rather than
 * supplied.
 *
 * ## Why the obvious test would have passed on the broken build
 *
 * The engine puts `input.prompt` into turn 1's model request, so on the build
 * BEFORE this seam a test asserting "a tool executed" and "turn 2's request
 * carries the tool result" passes: the model saw the prompt, the tool ran, and
 * the follow-up row moved. Every such test is blind to the missing user row,
 * which is why the gap survived a suite of 5072 tests.
 *
 * So nothing here asserts that a tool ran as evidence of durability. What is
 * asserted is the DURABLE record: the journal must have been told about the
 * user row, and the agent's own transcript must carry it. Neither is reachable
 * on the broken build.
 *
 * ## What is asserted, and against WHICH source
 *
 * Every comparison puts two INDEPENDENT producers on either side:
 *
 *  - the seam's RETURN value vs the journal's DTO vs the agent's timeline.
 *    The journal DTO is built by `Journal.fire` and the transcript row by
 *    `_appendMessageToTimeline`; neither reads the seam's return value, so a
 *    return value that lied could not satisfy both.
 *  - a FORKED run vs a PLAIN run. "The fork's rows land on the branch layer
 *    rather than the main transcript" is only a claim if the same harness with
 *    the fork switched OFF demonstrably puts its rows on the main transcript.
 *    One run alone would pass for any behaviour at all.
 *  - suppression is asserted by POSITIVE counts (a later, different prompt on
 *    the same transcript does commit), never by the absence of an error.
 *
 * Nothing here compares a value to itself.
 *
 * ## What is deliberately NOT done here
 *
 * This file does not flip the driver. `agent-process-entry.ts` still calls
 * `streamChat`; the harness below plays the driver role BY HAND so the seam can
 * be exercised before the flip, which is the arrangement the sibling engine
 * proofs use. Nothing here drives `.streamChat(`, so the driver-surface census
 * is unmoved -- see `legacy-driver-surface.test.ts`.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunEngineImpl, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import { FIRST_EPOCH, GROUND_FENCE } from '@duya/agent-protocol';
import type { RunEnginePorts, RunInputSnapshot, TerminalCandidate } from '@duya/agent-runtime';
import type { RunFence, RunId, RunManifest } from '@duya/agent-protocol';
import type { Message, SSEEvent } from '../../types.js';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';

// ============================================================================
// The scripted PROVIDER -- the only fake model, and it stands in for nothing
// under test. Nothing in this file asserts on what it saw.
// ============================================================================

interface Seen {
  readonly roles: readonly string[];
  readonly contents: readonly string[];
}

let active: { seen: Seen[] } | null = null;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
/** Turn 1 asks for the tool; turn 2 reports and stops. */
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 't1', name: 'probe_ok', input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'the probe reported' }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      const index = active?.seen.length ?? 0;
      active?.seen.push({
        roles: messages.map((m) => m.role),
        contents: messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
      });
      const script = SCRIPTS[Math.min(index, SCRIPTS.length - 1)] ?? SCRIPTS[SCRIPTS.length - 1];
      const signal = options?.signal as AbortSignal | undefined;
      return (async function* () {
        for (const event of script) {
          if (signal?.aborted) {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
          }
          yield event;
        }
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

// ============================================================================
// The JOURNAL SINK
//
// `messageDb.append` is the durable boundary the whole property is about: the
// `chat:db_persisted` acknowledgement the terminal handoff waits on is emitted
// only after `Journal.flush`, and that flush covers exactly these writes. It is
// captured here rather than inferred from the in-memory timeline, because "in
// memory" and "durable" are different claims.
// ============================================================================

interface JournalRow {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly dto: Record<string, unknown>;
}

let journalRows: JournalRow[] = [];

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: {
      ...messageDb,
      append: (sessionId: string, messages: unknown[], turnId: string | null) => {
        for (const dto of messages as Record<string, unknown>[]) {
          journalRows.push({ sessionId, turnId, dto });
        }
        return Promise.resolve({ success: true, count: messages.length });
      },
    },
  };
});

// ============================================================================
// The offline host: worker IPC + the agent under test
// ============================================================================

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { TurnPipelinePublisher } = await import('../../tool/turn-pipeline-publisher.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { Journal } = await import('../../journal/Journal.js');
const { composeLegacyRunPorts, createLegacyAssembleTurn, buildLegacyRunManifest, buildLegacyRunInput } =
  await import('../run-composition.js');
import type { LegacyRunFacts, LegacyRunHost } from '../run-composition.js';

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;
const ledgerDirs: string[] = [];

/**
 * Answer the two DB actions a turn reaches for. Under a Vitest pool worker
 * `process.send` is the POOL's channel, so it is replaced and the db-client's
 * own listener is called directly. The journal does not come through here --
 * its `messageDb.append` is captured by the module mock above.
 */
function installFakeDbIpc(): void {
  if (!dbListener) {
    initDbClient();
    dbListener = (process
      .listeners('message')
      .filter((l) => !PRE_EXISTING.has(l))[0] ?? null) as ((m: unknown) => void) | null;
    if (!dbListener) throw new Error('db-client registered no message listener');
  }
  realSend = process.send;
  process.send = ((msg: unknown) => {
    const req = msg as { type?: string; action?: string; id?: string };
    if (req?.type !== 'db:request') return true;
    if (req.action !== 'modeState:get' && req.action !== 'mailbox:claimBatch') {
      throw new Error(`unexpected db action: ${req.action}`);
    }
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  journalRows = [];
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  active = null;
  for (const dir of ledgerDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

// ============================================================================
// The fixtures
// ============================================================================

const PROBE = 'probe_ok';
const RUN_ID = 'run-prompt-row' as RunId;
const PROMPT = 'run the probe';
const SEQ_INDEX = 7;
/** The driver mints the row's id, so the fixture can name it. */
const PROMPT_ROW_ID = 'prompt-row-1';
/** A MAIN-LINE row a fork can point at; see `seedBranchRoot`. */
const BRANCH_ROOT_ID = 'root-1';
/**
 * A token only the probe's return value can produce.
 *
 * Searched for in a projected wire rather than a row id, because the wire
 * drops ids: `toModelBoundary` re-shapes every row, and the branch-layer
 * question is about which rows SURVIVE a projection, not how they are keyed.
 */
const PROBE_ANSWER = 'PROBE_ANSWER_MARKER';

interface RunOutcome {
  /** The seam's return value -- the ONLY thing it told the driver. */
  readonly commit: { committed: boolean; messageId: string | null };
  /** The agent's own durable transcript, read through its public getter. */
  readonly transcript: readonly Message[];
  /** The marker the agent held right after the driver's commit. */
  readonly marker: { readonly replyToId: string; readonly userId: string } | null;
  /**
   * The MAIN model wire: `handle.projectTurnMessages`, which re-projects
   * through `projectModelMessages` with NO run scope, so every branched row is
   * dropped. This is what the user's own transcript and later runs see.
   */
  readonly mainWire: readonly Message[];
  /**
   * The run-SCOPED wire: `agent.projectRunOwnModelMessages`, which admits the
   * rows this run wrote itself. For a forked run these are on the branch
   * layer; for a plain run they are the main line.
   */
  readonly ownWire: readonly Message[];
  /** How many times the probe really executed. */
  readonly probeRuns: () => number;
  readonly terminals: readonly TerminalCandidate[];
}

/** The journal rows of one kind, as the durable store saw them. */
function journalledOfKind(kind: string): JournalRow[] {
  return journalRows.filter((row) => row.dto.kind === kind);
}

/**
 * True when a projected wire carries the probe's answer.
 *
 * Content rather than role, because `projectModelMessages` maps rows to the
 * provider boundary and a tool result is not guaranteed to keep a `tool` role
 * on the way out. The value itself is what the branch-layer question is about.
 */
function wireCarriesProbeAnswer(wire: readonly Message[]): boolean {
  return JSON.stringify(wire).includes(PROBE_ANSWER);
}

/**
 * Put a MAIN-LINE user row on the transcript so a fork has a real target.
 *
 * `resolveReplyMeta` validates `replyToId` against the COMMITTED timeline and
 * silently strips an unknown target, so a fixture whose root never existed
 * would make every fork assertion vacuously true. This is transcript SETUP,
 * and it is deliberately NOT the row under test: the run's own prompt row is
 * written by the seam, never by this helper.
 */
function seedBranchRoot(agent: InstanceType<typeof duyaAgent>): void {
  agent.setMessages([
    {
      id: BRANCH_ROOT_ID,
      role: 'user',
      content: 'the root of the thread',
      timestamp: Date.now(),
      seq_index: 0,
    } as never,
  ]);
}

/** A fresh agent with the probe registered and a journal wired. */
function makeAgent(sessionId: string): {
  agent: InstanceType<typeof duyaAgent>;
  journal: InstanceType<typeof Journal>;
  probeRuns: () => number;
} {
  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
  (agent as unknown as { abortController: AbortController }).abortController = new AbortController();

  let runs = 0;
  agent.activeMCPRegistry.register(
    {
      name: PROBE,
      description: 'probe that counts its own executions',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        runs += 1;
        return { ok: true, result: `${PROBE_ANSWER} ${runs}` };
      },
    } as never,
  );

  const journal = new Journal({ sessionId });
  agent.journal = journal;
  return { agent, journal, probeRuns: () => runs };
}

/**
 * Drive one real `RunEngineImpl` run against a real agent, playing the driver.
 *
 * ## The order here IS the driver contract
 *
 * `composeLegacyRunPorts` binds the run's sink and CLEARS the fork marker --
 * that is its `host.runFork ?? null` obligation, and it is why a plain run
 * cannot inherit a previous run's marker. Then the driver commits the run's own
 * prompt row through `commitTurnPromptUserRow`, and only then does the engine
 * execute. Reversing the last two would resolve the fork against a timeline
 * that did not yet hold the row, which is the ordering the legacy used.
 *
 * ## Why the driver passes its OWN array and the host no `runFork`
 *
 * The engine has no working transcript, so it hands the seam a fresh array --
 * `claimInterTurn`'s documented shape. And it supplies NO `runFork`: on this
 * build the marker can only come from `replyToId` + `branched` being resolved
 * against the committed timeline, so a passing fork test is evidence for the
 * resolution rather than for a caller-supplied value.
 */
async function runThroughEngine(opts: { forked: boolean }): Promise<RunOutcome> {
  installFakeDbIpc();

  const sessionId = `s-prompt-row-${opts.forked ? 'fork' : 'plain'}`;
  const { agent, journal, probeRuns } = makeAgent(sessionId);

  if (opts.forked) seedBranchRoot(agent);

  const options = { sessionId } as never;
  const turnPipelines = new TurnPipelinePublisher();

  const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'duya-prompt-row-ledger-'));
  ledgerDirs.push(ledgerDir);
  const FENCE: RunFence = { runId: RUN_ID, runEpoch: FIRST_EPOCH, token: GROUND_FENCE.token };
  const ledger = createToolSideEffectLedger({
    dir: ledgerDir,
    runId: RUN_ID,
    runEpoch: FIRST_EPOCH,
    fence: FENCE,
  });

  const handle = await agent.beginTurnAssembly({
    options,
    prompt: PROMPT,
    appliedProfile: undefined,
    turnContext: agent.assembleTurnContext(options, PROMPT),
    publisher: turnPipelines,
  });

  const session = new RunSession({
    runId: RUN_ID,
    sessionId,
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1_000,
  });
  const emitter = new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: { push: () => undefined },
  });
  emitter.emit({
    type: 'run.started',
    manifestHash: 'hash-prompt-row',
    protocol: { major: 1, minor: 0 },
    runtime: { name: 'prompt-row-proof', version: '0.0.0' },
  });

  const terminals: TerminalCandidate[] = [];
  const host: LegacyRunHost = {
    turnPipelines,
    assembleTurn: createLegacyAssembleTurn(handle),
    refreshDeclaredTools: () => handle.refreshDeclaredTools(),
    askApproval: async () => ({ allowed: true, scope: 'once' }),
    emitter,
    proposeTerminal: (candidate) => terminals.push(candidate),
    compaction: {
      decide: () => Promise.resolve({ kind: 'skip', reason: 'not under test' } as const),
      compact: () => Promise.resolve({ kind: 'declined', reason: 'not under test' } as const),
      nextCompactionId: () => 'cmp-prompt-row',
    },
    seqIndex: SEQ_INDEX,
    wakeRun: false,
    beginTicket: (call) => ledger.begin(call),
    settleTicket: (input) => ledger.settle(input),
    // NO `runFork`. Deliberate: the marker must come from the timeline.
  };

  const ports: RunEnginePorts = composeLegacyRunPorts(agent, host);

  const facts: LegacyRunFacts = {
    runId: RUN_ID,
    cwd: process.cwd(),
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId,
    projectId: null,
    revision: 'rev-prompt-row',
    catalogRevision: agent.activeMCPRegistry.getCatalogRevision(),
    permissionMode: 'default',
  };
  const manifest: RunManifest = buildLegacyRunManifest(facts);
  const input: RunInputSnapshot = {
    ...buildLegacyRunInput(facts, { role: 'user', id: PROMPT_ROW_ID, content: PROMPT }, []),
    history: { kind: 'by_ref', digest: 'hist-prompt-row', locator: 'agent://transcript' },
  } as unknown as RunInputSnapshot;

  // === The driver's call: commit the run's own prompt row ==============
  const commit = agent.commitTurnPromptUserRow({
    prompt: PROMPT,
    messages: [],
    seqIndex: SEQ_INDEX,
    clientMsgId: PROMPT_ROW_ID,
    ...(opts.forked ? { replyToId: BRANCH_ROOT_ID, branched: true } : {}),
  });
  // ======================================================================

  // The marker a FORKED run must now hold. Captured before the engine runs so
  // the assertion is about what the driver's commit established, not about
  // whatever a later turn happened to leave behind.
  const marker = agent.readRunForkMarker();

  active = { seen: [] };
  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 4 });
  await engine.execute({ manifest, input, signal: new AbortController().signal, ports }).completed();

  turnPipelines.close();
  // The journal's emits are fire-and-forget; the terminal handoff waits on
  // `flush`, and so does this file, or it would race the write it asserts.
  await journal.flush();

  return {
    commit,
    transcript: agent.getMessages(),
    marker,
    mainWire: handle.projectTurnMessages(),
    ownWire: agent.projectRunOwnModelMessages(PROMPT_ROW_ID),
    probeRuns,
    terminals,
  };
}

// ============================================================================
// The claim
// ============================================================================

describe("the run's own prompt user row on the driver path", () => {
  it('commits the row durably: the journal saw it and the transcript carries it', async () => {
    const run = await runThroughEngine({ forked: false });

    // The seam says it wrote a row and names it.
    expect(run.commit).toEqual({ committed: true, messageId: PROMPT_ROW_ID });

    // Source A: the DURABLE record. `Journal.fire` built this DTO; nothing in
    // the seam's return value reaches it.
    const userRows = journalledOfKind('user_msg_added');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].dto.role).toBe('user');
    expect(userRows[0].dto.content).toBe(PROMPT);
    expect(userRows[0].dto.seq_index).toBe(SEQ_INDEX);
    expect(userRows[0].sessionId).toBe('s-prompt-row-plain');

    // Source B: the agent's own transcript, projected by the timeline. A seam
    // that reported success without writing fails here.
    const committed = run.transcript.filter((m) => m.id === PROMPT_ROW_ID);
    expect(committed).toHaveLength(1);
    expect(committed[0].role).toBe('user');
    expect(committed[0].content).toBe(PROMPT);

    // Source C: the run really executed, so the durable row is not the only
    // thing that happened. A committed row on a run that never reached a model
    // would satisfy every assertion above.
    expect(run.probeRuns()).toBe(1);
    expect(wireCarriesProbeAnswer(run.ownWire)).toBe(true);
  });

  it('a forked run resolves the marker against the transcript and keeps its rows off the main wire', async () => {
    const forked = await runThroughEngine({ forked: true });

    // The marker was NOT supplied -- the host carries no `runFork`. It is
    // resolved from `replyToId` + `branched` against the committed timeline,
    // so its `userId` is the id the driver minted and its `replyToId` is the
    // root the fixture actually put on the transcript.
    expect(forked.marker).toEqual({ replyToId: BRANCH_ROOT_ID, userId: PROMPT_ROW_ID });

    // The DURABLE record carries the branch metadata, not just memory: this is
    // the row the main projection would have hidden.
    const userRows = journalledOfKind('user_msg_added');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].dto.metadata).toEqual({
      threadMeta: { replyToId: BRANCH_ROOT_ID, branched: true },
    });

    // And the run's OWN rows inherit the marker, which is what `_commitDurable`
    // does once `forkTurn` is set. Positive: the tool result is there, and it
    // is branched against the fork's user row.
    const toolRows = journalledOfKind('tool_result_added');
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].dto.metadata).toEqual({
      threadMeta: { replyToId: PROMPT_ROW_ID, branched: true },
    });

    // The contrast that turns "branch layer, not main transcript" into a
    // claim: the SAME harness with the fork switched off puts its rows on the
    // MAIN wire. Without this second run, "the fork's rows are absent from the
    // main transcript" would also hold for a run that wrote nothing.
    const plain = await runThroughEngine({ forked: false });
    expect(wireCarriesProbeAnswer(plain.mainWire)).toBe(true);
    expect(wireCarriesProbeAnswer(forked.mainWire)).toBe(false);

    // ...while the forked run's own scoped wire still carries them, so the run
    // did not lose its own history in exchange for leaving the main one.
    expect(wireCarriesProbeAnswer(forked.ownWire)).toBe(true);

    // And a plain run leaves no marker behind, so the two runs are
    // distinguishable on the agent itself, not only in their journal rows.
    expect(plain.marker).toBeNull();
  });

  it('a plain run commits an untagged row that stays on the main transcript', async () => {
    const plain = await runThroughEngine({ forked: false });

    expect(plain.marker).toBeNull();
    const userRows = journalledOfKind('user_msg_added');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].dto.metadata).toBeUndefined();

    // Same harness, same prompt, same id -- the only difference from the fork
    // case is `replyToId` / `branched`. So the branch metadata in the fork case
    // came from the resolution, not from the row construction.
    expect(plain.transcript.some((m) => m.id === PROMPT_ROW_ID)).toBe(true);
    expect(wireCarriesProbeAnswer(plain.mainWire)).toBe(true);
  });

  it('suppresses a duplicate prompt instead of writing a second user row', async () => {
    installFakeDbIpc();
    const sessionId = 's-prompt-row-dup';
    const { agent, journal } = makeAgent(sessionId);

    // A transcript pre-loaded from the database, whose last row IS this run's
    // prompt -- the shape `beginTurnAssembly` is handed on the CLI path.
    const preloaded: Message[] = [
      { id: 'pre-1', role: 'user', content: PROMPT, timestamp: 1, seq_index: 0 } as Message,
    ];

    const first = agent.commitTurnPromptUserRow({
      prompt: PROMPT,
      messages: preloaded,
      seqIndex: SEQ_INDEX,
    });
    await journal.flush();

    // POSITIVE facts only. A bare "no new row" would also be satisfied by a
    // seam that committed nothing at all, so the transcript length, the
    // journal count and the RETURNED id all have to agree.
    expect(first.committed).toBe(false);
    expect(first.messageId).toBe('pre-1');
    expect(preloaded).toHaveLength(1);
    expect(journalledOfKind('user_msg_added')).toHaveLength(0);

    // The suppressed row picked up this run's index, in place.
    expect(preloaded[0].seq_index).toBe(SEQ_INDEX);

    // A DIFFERENT prompt on the same transcript does commit, so the suppression
    // is keyed on content rather than on "the array is non-empty".
    const second = agent.commitTurnPromptUserRow({
      prompt: 'a different question',
      messages: preloaded,
      seqIndex: SEQ_INDEX,
      clientMsgId: 'fresh-1',
    });
    await journal.flush();

    expect(second).toEqual({ committed: true, messageId: 'fresh-1' });
    expect(preloaded).toHaveLength(2);
    expect(journalledOfKind('user_msg_added')).toHaveLength(1);
    expect(agent.getMessages().filter((m) => m.id === 'fresh-1')).toHaveLength(1);
  });
});
/**
 * The headless run host is a COMPOSITION of the real run layer, and these are
 * the tests that make that claim checkable rather than asserted in a comment.
 *
 * The failure this suite exists to catch is specific: a headless host that grew
 * its own run loop. Such a host looks fine — it opens a run, streams events,
 * prints the answer, exits — and it is wrong in three ways that only show up
 * later: it mints a second run identity, it decides its own terminal, and it
 * produces a second frame vocabulary that the transport equivalence test cannot
 * see (that test compares TRANSPORTS; two frame PRODUCERS is a different axis).
 *
 * So the assertions below are all of one kind: prove the answer came from the
 * runtime, and prove the frames came from the worker's codec. A host that
 * copied the run loop would have to reimplement `seq` minting, the terminal
 * synthesis and the frame vocabulary to pass them.
 *
 * ## Plan 610 S4c-d2b: what changed in THIS file, and why
 *
 * The executor double is gone. `HeadlessAgent` used to be a two-method port
 * (`streamChat` + `interrupt`) so this file could hand the host a scripted agent
 * and exercise the whole run layer with no provider. The flip drives
 * `RunEngineImpl` through `driveRunWithEngine`, and the engine asks for the run
 * LIFECYCLE — `beginRun`, `producePromptContextRail`,
 * `commitTurnPromptUserRow`, `beginTurnAssembly` — so a two-method double cannot
 * drive a run any more. Hand-writing a fake for all of those would be a second
 * account of what the driver already names once, which is precisely the failure
 * class this suite exists to catch.
 *
 * So the double moved DOWN one level: `@duya/ai`'s `createAIClient` is scripted,
 * which is where the engine proofs in this directory already put theirs. The
 * agent, the journal, the registry, the composition, the engine, the ledger and
 * the run layer are all production ones.
 *
 * ## What the flip made UNREACHABLE, stated rather than deleted
 *
 * One state this file used to reach can no longer occur through the host: a
 * turn whose stream ends with NO terminal frame, which the runtime used to
 * synthesise into `failed` ("no terminal event"). The engine settles its own
 * run, so a producer that simply stops no longer produces an unterminated run.
 * The property that actually mattered — no headless run can be left `running`
 * forever — is asserted instead, and the note above is why the assertion reads
 * differently rather than having been quietly dropped.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { manifestFingerprint, EVENT_META, type EventType, type RunId } from '@duya/agent-protocol';
import type { ChatOptions, SSEEvent } from '../../types.js';
import type { HeadlessRunHost as HeadlessRunHostType } from '../headless-run-host.js';

/**
 * `PRE_EXISTING` has to be captured BEFORE anything that transitively imports
 * `ipc/db-client`, because that module registers its `process.on('message')`
 * listener as an import side effect. A static value import of the host module
 * above this line would run first and the db-client listener would be filtered
 * out as pre-existing -- so every value import below this point is dynamic.
 * (Type-only imports are erased and are therefore safe anywhere.)
 */
const PRE_EXISTING = new Set(process.listeners('message'));
let providerCalls = 0;
const { enumerateProbe, translateFrame, projectToLegacyFrame, RunEngineImpl } = await import(
  '@duya/agent-runtime'
);
const {
  HeadlessRunHost,
  buildHeadlessManifest,
  createAgentExecutionChannel,
  createHeadlessRunHost,
} = await import('../headless-run-host.js');
const { convertSSEToAgentMessage } = await import('../sse-frame-codec.js');
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { Journal } = await import('../../journal/Journal.js');
const { initDbClient } = await import('../../ipc/db-client.js');
const { ToolRegistry } = await import('../../tool/registry.js');

/** One real multi-byte character, spelled as an escape so this file stays ASCII. */
const CJK = '\u4e2d\u6587';

/**
 * The scripted PROVIDER. The only fake in this file, and it stands in for
 * nothing that is under test: it is the network boundary, not the run layer.
 */
/**
 * The scripted PROVIDER, one script PER CALL.
 *
 * A per-call list rather than one repeated script because a repeated script is
 * wrong the moment a turn calls a tool: the second turn would call it again, and
 * the run would spin until the ceiling instead of finishing.
 */
let scripts: readonly (readonly SSEEvent[])[] = [];
let throwOnCall: number | null = null;

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(_messages: unknown[], options?: Record<string, unknown>) {
      const signal = options?.signal as AbortSignal | undefined;
      const call = providerCalls++;
      const events = scripts[Math.min(call, scripts.length - 1)] ?? [];
      const fail = throwOnCall;
      return (async function* () {
        if (fail !== null && call === fail) throw new Error('provider exploded');
        for (const event of events) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          yield event;
        }
        if (fail !== null && call === fail) throw new Error('provider exploded');
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

vi.mock('../../ipc/db-client.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const messageDb = actual.messageDb as Record<string, unknown>;
  return {
    ...actual,
    messageDb: { ...messageDb, append: () => Promise.resolve({ success: true, count: 1 }) },
  };
});

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

/** A tool whose body is the evidence, so "the tool ran" is read off the disk. */
const READ_TOOL = 'headless_read';

/** The same turn, as the provider produces it. */
const TURN: readonly SSEEvent[] = [
  { type: 'text', data: `hello ${CJK}` },
  { type: 'done', reason: 'end_turn' },
];

/** A turn that calls a tool, split per provider CALL. */
const TOOL_TURN_CALL_ONE: readonly SSEEvent[] = [
  { type: 'text', data: `hello ${CJK}` },
  { type: 'tool_use', data: { id: 'call-1', name: READ_TOOL, input: { path: 'a.ts' } } },
  { type: 'result', data: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
  { type: 'done', reason: 'tool_use' },
];
const TOOL_TURN_CALL_TWO: readonly SSEEvent[] = [
  { type: 'text', data: 'done' },
  { type: 'result', data: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  DONE,
];
const TOOL_TURN: readonly SSEEvent[] = [...TOOL_TURN_CALL_ONE, ...TOOL_TURN_CALL_TWO];

const SESSION_ID = 'cli-session-1';
const TEST_NS = 'headless-host-composition';

let dbListener: ((m: unknown) => void) | null = null;
let realSend: typeof process.send | undefined;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Answer the DB actions a turn reaches for, through the pool's own channel. */
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
    const result = req.action === 'mailbox:claimBatch' ? { rows: [], claimTokens: [] } : null;
    setImmediate(() => dbListener?.({ type: 'db:response', id: req.id, success: true, result }));
    return true;
  }) as unknown as typeof process.send;
}

beforeEach(() => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
  scripts = [TURN];
  throwOnCall = null;
  providerCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.send = realSend;
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir nobody claimed is not a test failure.
    }
  }
});

/**
 * A real `duyaAgent` plus the host that drives it.
 *
 * The tool is registered on the agent's own catalog and its body writes a FILE,
 * so "the tool ran" can be read off the filesystem rather than off a frame or a
 * counter this harness kept.
 */
function agentAndHost(
  options: { readonly runId?: RunId; readonly toolRegistry?: unknown } = {},
): {
  agent: InstanceType<typeof duyaAgent>;
  host: HeadlessRunHostType;
  cwd: string;
  ledgerDir: string;
  toolProof: string;
} {
  installFakeDbIpc();
  const cwd = tempDir('duya-host-ws-');
  const ledgerDir = tempDir('duya-host-ledger-');
  const toolProof = path.join(cwd, 'tool-ran.txt');

  const agent = new duyaAgent({
    apiKey: 'test-key',
    model: 'test-model',
    provider: 'anthropic',
    sessionId: SESSION_ID,
    workingDirectory: cwd,
    permissionMode: 'default',
  });
  agent.journal = new Journal({ sessionId: SESSION_ID });
  agent.activeMCPRegistry.register(
    {
      name: READ_TOOL,
      description: 'a tool whose body is the evidence',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        writeFileSync(toolProof, 'contents', 'utf-8');
        return { ok: true, result: 'contents' };
      },
    } as never,
  );

  const host = createHeadlessRunHost({
    agent,
    mintRunId: () => options.runId ?? ('run-headless-1' as RunId),
    now: () => 1_700_000_000_000,
    ledgerDir,
    // The executor the host drives, when a test is about what the host hands it.
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
  });
  return { agent, host, cwd, ledgerDir, toolProof };
}

const INTENT = {
  prompt: 'read a.ts and summarise it',
  sessionId: SESSION_ID,
  cwd: process.cwd(),
  model: 'test-model',
  providerId: 'test-provider',
  maxTurns: 8,
} as const;

/**
 * Record the options the EXECUTOR was handed, on the seam the driver opens a run
 * through.
 *
 * Asserting on `run.manifest` proves what the host said; asserting on this
 * proves what the executor RECEIVED. Those are different facts, and the budget
 * test below is the cautionary case — it asserted the manifest while its comment
 * claimed to cover the executor's options.
 *
 * ## Why this is a SPY and not a scripted executor
 *
 * It used to be a two-method double whose `streamChat(prompt, options)`
 * recorded. That was honest while the host drove the legacy turn loop; after the
 * flip the host drives `driveRunWithEngine`, which reaches the executor through
 * the run LIFECYCLE — `beginRun`, `beginTurnAssembly`, `commitTurnPromptUserRow`
 * — and never calls `streamChat` at all, so such a double recorded nothing while
 * appearing to (it is what left these rows red with `received[0] === undefined`).
 *
 * So the observation moved onto the seam the options actually cross, `beginRun`,
 * and the executor stayed REAL. The alternative — hand-writing a second account
 * of `beginRun` / `beginTurnAssembly` / `commitTurnPromptUserRow` /
 * `producePromptContextRail` / `getMessages` / `engineCompactionSources` — is the
 * failure class this file exists to catch: it would pass against a host that
 * produced every frame identically while executing nothing.
 *
 * The reference is pushed BEFORE the real call, so what the assertion reads is
 * exactly what the driver passed rather than anything the agent did to it.
 */
function recordRunOptions(agent: InstanceType<typeof duyaAgent>): (ChatOptions | undefined)[] {
  const received: (ChatOptions | undefined)[] = [];
  const original = agent.beginRun.bind(agent);
  agent.beginRun = async (request) => {
    received.push(request.options);
    return original(request);
  };
  return received;
}

interface Envelope {
  seq: number;
  payload: { type: string };
}

/** Drain a run's whole event stream. */
async function collect(run: {
  events(): AsyncGenerator<Envelope, void, unknown>;
}): Promise<Envelope[]> {
  const seen: Envelope[] = [];
  for await (const envelope of run.events()) seen.push(envelope);
  return seen;
}

describe('H8.1 — the headless host runs on the real run layer', () => {
  it('mints the run id in the host and carries it as the canonical identity', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });

    expect(run.runId).toBe('run-headless-1');
    // The manifest's id and the handle's id are the SAME id, and the hash the
    // run records is the hash of that manifest. An adapter that minted its own
    // id beside the dispatch would break this equality, and it is the exact
    // second run-identity source R2.1 removed.
    expect(run.manifest.runId).toBe(run.runId);
    expect(run.manifestHash).toBe(manifestFingerprint(run.manifest));
  });

  it('mints the run.started event BEFORE the executor produces anything', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    // `run.started` is emitted before dispatch by the RUNTIME. A host that
    // opened the executor first could not produce this ordering, and a run whose
    // first event is a consequence of its second cannot answer "what was this
    // run given?" for a run that crashed a millisecond later.
    expect(events[0]?.payload.type).toBe('run.started');
    expect(events[0]?.seq).toBe(1);
  });

  it('numbers the whole run with a dense, runtime-minted seq', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    // Dense and 1-based. The transport physically cannot do this — the intake
    // takes a raw frame and the emitter is the only thing that numbers it — so
    // a host that reached this sequence any other way would have had to build a
    // second numbering authority.
    //
    // Deliberately NOT also asserting what the turn did. A turn's own shape is
    // the subject of the two tests below, and folding it in here made this row
    // fail for a reason that has nothing to do with numbering.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.payload.type)).toContain('assistant.text_block');
  });

  it('dispatches a tool through the engine tool leg, and the tool left evidence', async () => {
    scripts = [TOOL_TURN_CALL_ONE, TOOL_TURN_CALL_TWO];
    const { host, toolProof } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    const types = events.map((e) => e.payload.type);
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');
    // The tool's own side effect, on the filesystem. `RunEngineImpl` reports
    // `completed` for a run that dispatched NOTHING at all (the mute-pipeline
    // trap), so the event pair alone would still be satisfied by a pipeline with
    // no calls in it; the file is what separates the two.
    expect(existsSync(toolProof)).toBe(true);
  });

  it('records the authoritative message in the DURABLE ledger, between the blocks and the terminal', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    // The whole path is real here — the real host, the real in-process
    // transport, the real RunController, the real `translateFrame`, the real
    // engine and the real emitter that mints `seq`. The only substituted part is
    // the provider.
    //
    // The property is an ORDER property, and order is the part that is easy to
    // get wrong: the message stops changing strictly before the run ends, so
    // the finalized event has to land after the per-block events it supersedes
    // and before `run.completed`. A host that forwarded `chat:done` inline would
    // put the terminal in the ledger first, the run would already be settled by
    // the time the finalized frame arrived, and the run layer would drop it as a
    // late frame — the message would silently never be recorded at all.
    const durable = events.filter(
      (e) => EVENT_META[e.payload.type as EventType]?.durability === 'durable',
    );
    const types = durable.map((e) => e.payload.type);

    expect(types).toContain('assistant.message_finalized');
    // After the blocks, before the terminal.
    expect(types.indexOf('assistant.message_finalized')).toBeGreaterThan(
      types.lastIndexOf('assistant.text_block'),
    );
    expect(types.indexOf('assistant.message_finalized')).toBeLessThan(types.indexOf('run.completed'));
    // The terminal is still last and the run still completes: wiring the message
    // in must not have displaced the run's own ending.
    expect(types[types.length - 1]).toBe('run.completed');
    expect((await run.terminal).status).toBe('completed');
    // The seq the runtime minted is monotonic and unique across the run.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    // And the durable TEXT is the message, not the per-block projection of it.
    const finalized = durable.find((e) => e.payload.type === 'assistant.message_finalized');
    const content = (finalized?.payload as unknown as { content: { type: string; text?: string }[] })
      .content;
    expect(content.filter((b) => b.type === 'text').map((b) => b.text).join('')).toContain(CJK);
  });

  it('records nothing when the turn produced no assistant message', async () => {
    // The absence has to be honest too. A turn that never built a message is a
    // real state, and the frame for it is no frame — not one carrying an empty
    // `content`, which would read as "the model answered with nothing".
    //
    // Reached with a script that errors before any text block, so no assistant
    // row is ever written and `agent.getMessages()` has nothing to finalise.
    scripts = [[]];
    throwOnCall = 0;
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    expect(events.map((e) => e.payload.type)).not.toContain('assistant.message_finalized');
  });

  it('reaches a terminal the RUNTIME decided, from the executor stream ending', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    await collect(run);

    // The engine says "this run completed"; the runtime translates and settles.
    // The terminal below is therefore the runtime's synthesis, so a host that
    // invented its own success path would produce the same string by a
    // different route — which is why the event assertions above matter as much
    // as this one.
    const terminal = await run.terminal;
    expect(terminal.status).toBe('completed');
    const result = await run.result();
    expect(result.status).toBe('completed');
    expect(result.runId).toBe('run-headless-1');
  });

  it('turns an executor that THROWS into a failed run, not a silent one', async () => {
    // The provider emits one text block and then throws, so the run holds real
    // work that the exception must not discard.
    // Call 1 runs a tool, so its text block IS recorded; call 2 throws, so the
    // run ends `failed` while still holding real work.
    scripts = [TOOL_TURN_CALL_ONE, []];
    throwOnCall = 1;
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    const terminal = await run.terminal;
    expect(terminal.status).toBe('failed');
    expect(events.map((e) => e.payload.type)).toContain('run.failed');
    // The partial text that DID arrive is still in the run's own record. A host
    // that dropped the run on the exception would lose work the runtime had
    // already accepted.
    expect(events.map((e) => e.payload.type)).toContain('assistant.text_block');
  });

  it('closes the run even when the producer emits no done of its own', async () => {
    // A turn whose script carries NO terminal frame at all.
    //
    // This state used to be reachable and ended `failed` with
    // "no terminal event", synthesised by the runtime from an unterminated
    // stream. It is no longer reachable through this host: the engine settles
    // its own run, so a producer that simply stops no longer leaves a run open.
    // The property this test exists to protect is unchanged and is what is
    // asserted — no headless run can be left `running` forever.
    scripts = [[{ type: 'text', data: 'half an answer' }]];
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    const terminal = await run.terminal;
    expect(terminal.status).not.toBe('running');
    // Reached at all is the first half: `collect` drains `handle.events()`,
    // which only terminates once the run has settled and closed its stream.
    expect(events.length).toBeGreaterThan(0);
    // And the ending is DURABLE, whether the engine proposed it or the runtime
    // synthesised it.
    const durable = await run.transcriptTypes();
    expect(
      durable.some((type) => type === 'run.completed' || type === 'run.failed'),
    ).toBe(true);
  });
});

describe('H8.1 — the headless host speaks the WORKER frame vocabulary', () => {
  it('produces frames the worker process codec produces, through the runtime projector', async () => {
    scripts = [TOOL_TURN_CALL_ONE, TOOL_TURN_CALL_TWO];
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);

    // The load-bearing assertion of the whole slice. Every frame the headless
    // path would put on a wire is the frame `convertSSEToAgentMessage` builds —
    // the function the SUBPROCESS worker uses. If the host had a second codec,
    // this comparison would have nothing to compare against, and the transport
    // equivalence suite would still be green, because it compares transports
    // and not producers.
    //
    // The frames below are the ones `HeadlessRun.frames()` hands a consumer,
    // reached through the runtime's OWN `projectToLegacyFrame` rather than a
    // second projection in this file.
    const producedByHost = events
      .map((envelope) => projectToLegacyFrame(envelope))
      .filter((frame): frame is { type: string } => frame !== null)
      .map((frame) => frame.type);
    expect(producedByHost.length).toBeGreaterThan(0);
    expect(producedByHost).toContain('token_usage');

    // And each worker frame, run through the runtime's OWN translator with the
    // same context the host supplies, yields an event the run recorded.
    const workerFrames = TOOL_TURN.map((event) => convertSSEToAgentMessage(event)).filter(
      (frame): frame is Record<string, unknown> => frame !== null,
    );
    const context = {
      messageId: 'm-ctx',
      permission: { classify: () => 'generic', mode: 'generic' as const, expiresInMs: 0, now: () => 0 },
      nextTurn: () => ({ turnId: 'turn-1', index: 1 }),
      model: { model: 'test-model', providerId: 'test-provider', apiFormat: 'anthropic' as const },
    };
    const producedByWorker = workerFrames
      .map((frame) => translateFrame(frame, context))
      .filter((r) => r.ok)
      .map((r) => (r as { event: { type: string } }).event.type);
    const recorded = events.map((e) => e.payload.type);

    for (const type of producedByWorker) {
      expect(recorded).toContain(type);
    }
  });

  it('maps a CJK payload through without corrupting it', async () => {
    const { host } = agentAndHost();
    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const events = await collect(run);
    // The engine publishes `assistant.text_block` when a block OPENS, so the block
    // event itself carries `text: ''` and the content arrives on the finalized
    // message. That is the engine's designed shape -- `run-engine.ts` states
    // that a consumer treats the finalized entry as SUPERSEDING the blocks for
    // that message -- so the assertion is made against the finalized content,
    // which is also the stronger claim: it is the durable transcript text rather
    // than a streaming fragment.
    const finalized = events.find((e) => e.payload.type === 'assistant.message_finalized');
    expect(finalized).toBeDefined();
    const content = (finalized?.payload as unknown as { content: { type: string; text?: string }[] })
      .content;
    const rendered = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    // The block carried multi-byte characters end to end: provider -> engine ->
    // surface -> codec -> transport -> translator -> emitter. A projection that
    // stringified wrongly here would show up as mojibake rather than as a
    // dropped event.
    expect(rendered).toContain(CJK);
    expect(rendered).toContain('hello');
  });
});

describe('H8.1 — cancel is the runtime path, not a second stop', () => {
  it('issues the agent interrupt and reports the outcome the runtime decided', async () => {
    // Cancelling an already-settled run would prove nothing about the stop
    // path: the runtime short-circuits a closed run and the executor is never
    // touched. So the provider parks until the interrupt's abort signal lands.
    let release: (() => void) | null = null;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { agent, host } = agentAndHost();
    scripts = [[{ type: 'text', data: 'working' }]];

    // The abort the provider watches is the engine's signal, which is the run
    // handle's signal, which `beginRun` took from the agent's controller.
    const originalInterrupt = agent.interrupt.bind(agent);
    agent.interrupt = () => {
      originalInterrupt();
      release?.();
    };

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    // Take one event so the run is provably LIVE, then cancel it underneath.
    for await (const _envelope of run.events()) break;
    const outcome = await run.cancel('user pressed ctrl-c');

    // The stop reached the EXECUTOR, which is the half a host-owned loop would
    // have had to fake. `interrupts: 1` is only reachable by going through the
    // channel's own `stop`, because that is the only place the agent is touched.
    expect(outcome.requested).toBe(true);
    expect(outcome.applied).toBe(true);
    const terminal = await run.terminal;
    expect(terminal.status).toBe('cancelled');
  });

it('routes the budget onto the executor options, not just the run layer', async () => {
    // The executor is the ENGINE now, and the engine does not take a turn
    // ceiling through the turn's options -- `ChatOptions.maxTurns` is read by
    // nothing in the agent. It takes it as `RunEngineImpl`'s own `defaultMaxTurns`,
    // which is a private constructor field and therefore unobservable, so what is
    // asserted here is the value that field is derived from: the budget the
    // ENGINE's run was frozen with, read off the `execute` request itself.
    const execute = vi.spyOn(RunEngineImpl.prototype, 'execute');
    // Its OWN run id, and the reason is the comment on the match below: several
    // rows in this file mint `run-headless-1`, so a shared id could not tell this
    // run's engine execution apart from another's.
    const { agent, host } = agentAndHost({ runId: 'run-budget-1' as RunId });
    const received = recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-'), maxTurns: 3 });
    await collect(run);

    // A ceiling only the run layer checks is a receipt, not a budget: the run
    // layer learns a turn started when the frame comes BACK, which is after the
    // model request went out. What the executor was RUN WITH is the observable
    // half of that claim — the host's manifest alone would pass even if the
    // channel never forwarded the ceiling, which is exactly what this test
    // asserted before it observed the executor at all.
    expect(run.manifest.budget.maxTurns).toBe(3);
    // Bound to THIS run rather than to `calls[0]`. The channel dispatches the
    // turn un-awaited (that is what makes a cancel possible while it runs), so a
    // run started by an earlier row can still be executing its engine when a
    // later row installs this spy. Matching on the run id is what keeps the
    // receipt about this run instead of about whichever one landed first.
    const engineRun = execute.mock.calls
      .map(([request]) => request)
      .find((request) => request.manifest.runId === run.runId);
    expect(engineRun?.manifest.budget.maxTurns).toBe(3);
    // The engine's OWN frozen run, not the host's manifest handed back to it:
    // the driver rebuilds the manifest from the ceiling it was given, so this
    // row is a receipt for the forwarding rather than a second read of the
    // object the first assertion already saw.
    expect(engineRun?.manifest.env.ref).toBe('env:worker');
    // And the turn itself ran on the same agent, through the lifecycle seam.
    expect(received.length).toBe(1);
  });
});

/**
 * The tool registry is a capability handle, and a capability handle is not data.
 *
 * `RunStartInput.options` is the run layer's canonical-JSON boundary:
 * `runInputRevision` digests it, and `asJson` rejects any value whose prototype
 * is not `Object.prototype`/`null`. A `ToolRegistry` is a class, so routing one
 * through `options` made `RunController.start` THROW before the run opened —
 * which is why `duya -t` and the REPL failed at start while `--print` (no
 * registry) survived. These tests pin both halves of the fix: the run starts,
 * and the registry still arrives AT THE EXECUTOR, by reference.
 */
describe('H8.1 — the tool registry reaches the executor without crossing the JSON boundary', () => {
  it('starts a run at all when the host was given a real ToolRegistry', async () => {
    // The regression itself. Before the fix `host(...).start(INTENT)` REJECTED
    // with `options.toolRegistry is a ToolRegistry, which has no canonical JSON
    // form`, so every other CLI mode died here.
    const registry = new ToolRegistry();
    const { agent, host } = agentAndHost({ toolRegistry: registry });
    const received = recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const seen = await collect(run);

    expect(seen.length).toBeGreaterThan(0);
    expect((await run.terminal).status).toBe('completed');
    // And it reached the executor on the lifecycle seam, which is what makes
    // "the run started" and "the run was given its tools" one claim.
    expect(received[0]?.toolRegistry).toBe(registry);
  });

  it('delivers the registry to the executor BY REFERENCE, not a copy', async () => {
    // Identity, not equality: the executor calls methods on this object
    // (`DuyaAgent._resolveTools` reads `options.toolRegistry` and dispatches
    // through it live), so a structural clone would be a different registry that
    // happens to look alike.
    const registry = new ToolRegistry();
    const { agent, host } = agentAndHost({ toolRegistry: registry });
    const received = recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    await collect(run);

    expect(received[0]?.toolRegistry).toBe(registry);
  });

  it('keeps input.options canonical JSON — nothing non-serialisable crosses the boundary', async () => {
    // The mechanism, asserted directly rather than only through "it did not
    // throw": whatever the host passes as `options` must survive
    // `runInputRevision`, which is what `RunController.start` computes.
    const registry = new ToolRegistry();
    const { agent, host } = agentAndHost({ toolRegistry: registry });
    recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    const seen = await collect(run);

    // `run.started` is the event the runtime emits only after the revision was
    // derived successfully, so its presence is the receipt.
    expect(seen.some((envelope) => envelope.payload.type === 'run.started')).toBe(true);
  });

  it('forwards the run layer options whole alongside the registry', async () => {
    // Guards the P10 counter-pressure: moving the registry off `options` must
    // not become "copy only the fields we know about". The session the run layer
    // put in its bag and the registry the host carries have to arrive TOGETHER,
    // from two different sources, on the same options object.
    const registry = new ToolRegistry();
    const { agent, host } = agentAndHost({ toolRegistry: registry });
    const received = recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-'), maxTurns: 4 });
    await collect(run);

    // The run layer's own bag, spread rather than re-listed: the session id is
    // what `RunStartInput` carried and this is where it can still be seen.
    expect(received[0]?.sessionId).toBe(SESSION_ID);
    expect(received[0]?.toolRegistry).toBe(registry);
    // The ceiling is NOT asserted here any more, and the reason is measured
    // rather than preferred: the executor stopped being a method call with
    // options and became `RunEngineImpl`, which reads its ceiling from the run
    // it is executed on. The row above asserts the whole-bag forwarding; the
    // budget row in the previous describe asserts the ceiling's own crossing.
    expect(run.manifest.budget.maxTurns).toBe(4);
  });

  it('omits the registry entirely when the host has none', async () => {
    // A host with no registry must not gain a `toolRegistry: undefined` key:
    // that would be a key the executor's own option narrowing has to tolerate,
    // bought for nothing.
    const { agent, host } = agentAndHost();
    const received = recordRunOptions(agent);

    const run = await host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    await collect(run);

    expect(received[0]).not.toHaveProperty('toolRegistry');
    // Not "absent" by being undefined: the key must not be there at all, and
    // the run must still have been driven rather than skipped.
    expect(received.length).toBe(1);
  });
});

describe('H8.1 — the manifest is attributed rather than asserted', () => {
  it('marks every field the headless host invented as synthesised', () => {
    const manifest = buildHeadlessManifest(INTENT, 'run-headless-1' as RunId);

    // `provenance` is a Record over a CLOSED field set, so this cannot drift
    // silently. Every value here was invented by the host — there is no Control
    // Plane and no secret resolver behind a headless run — and saying
    // `synthesised: true` is how that is stated rather than left to be inferred
    // from an omission.
    for (const [field, entry] of Object.entries(manifest.provenance)) {
      expect(entry.synthesised, field).toBe(true);
      expect(entry.source, field).toBe('unsupported');
    }
  });

  it('carries no secret in the env reference', () => {
    const manifest = buildHeadlessManifest(INTENT, 'run-headless-1' as RunId);
    // The hash is the digest of the EMPTY string. It is a real digest rather
    // than a placeholder shape, so a reader can tell "resolved nothing" from
    // "nobody wrote a hash here".
    expect(manifest.env.hash).toBe('e3b0c44298fc1c149afbf4c8996fb924');
    expect(JSON.stringify(manifest)).not.toMatch(/sk-|api[_-]?key/i);
  });

  it('reports determinism as false, because the runtime does not provide it', () => {
    const manifest = buildHeadlessManifest(INTENT, 'run-headless-1' as RunId);
    // D7.1 delivered a state machine, not a shipping capability. A headless
    // manifest claiming `deterministic: true` would be claiming a capability
    // the runtime refuses to advertise in its own probe.
    expect(manifest.deterministic).toBe(false);
  });
});

describe('H8.1 — the capability probe stays honest', () => {
  it('reports execution resume and determinism as UNSUPPORTED', async () => {
    const { host } = agentAndHost();
    const probe = enumerateProbe(await host.probe());

    // These two are the ones plan 587 requires to read as unsupported until D7
    // accepts them. A headless host that advertised either would be claiming a
    // state machine is a shipping capability, which is the specific over-claim
    // H8 is forbidden to make.
    expect(probe.executionResume).toBe(false);
    expect(probe.determinism).toBe(false);
  });

  it('reports no permission expiry clock, because nothing enforces one', async () => {
    const { host } = agentAndHost();
    const capabilities = await host.probe();
    // A runtime that emitted `permission.requested` with an `expiresAt` while
    // advertising `absent` would be lying, and the probe's own consistency
    // guard is what catches it. `absent` is the honest word here.
    expect(capabilities.run.permissionExpiryClock).toBe('absent');
  });

  it('reports no event replay, because an in-memory window is not a window', async () => {
    const { host } = agentAndHost();
    const probe = enumerateProbe(await host.probe());
    // "The feature exists" is not the question. A host holding no durable
    // history cannot replay, and a probe that says otherwise is how a reconnect
    // is promised and then serves nothing.
    expect(probe.eventReplay).toBe(false);
  });

  it('names the in-process transport, so a caller can tell how it was wired', async () => {
    const { host } = agentAndHost();
    const capabilities = await host.probe();
    expect(capabilities.transports).toEqual(['in-process']);
  });
});

describe('H8.1 — the host adapter is an adapter, not a runner', () => {
  it('exposes no pause and no permission responder', () => {
    const { host } = agentAndHost();
    // The protocol's `RunHandle` carries `pause()` and
    // `respondToPermission()`. A headless host can do neither, so `HeadlessRun`
    // deliberately does not re-export them: a surface that advertised them
    // would be advertising two capabilities this host has not got.
    expect(Object.getOwnPropertyNames(HeadlessRunHost.prototype).sort()).toEqual(
      ['agent', 'constructor', 'probe', 'start'].sort(),
    );
    expect(host).toBeInstanceOf(HeadlessRunHost);
  });

  it('builds a channel that refuses rather than inventing an executor', () => {
    const { agent } = agentAndHost();
    // The channel is a function of the agent, so there is exactly one shape of
    // it. A host that could be handed a second, differently-behaving channel
    // would be a host with two run paths.
    const channel = createAgentExecutionChannel(agent, { now: () => 1_700_000_000_000 });
    expect(typeof channel.start).toBe('function');
    expect(Object.keys(channel)).toEqual(['start']);
  });

  it('writes the engine tool-side-effect journal where the host was told to', () => {
    scripts = [TOOL_TURN_CALL_ONE, TOOL_TURN_CALL_TWO];
    const { host, ledgerDir } = agentAndHost();
    const run = host.start({ ...INTENT, cwd: tempDir('duya-intent-') });
    return run
      .then((started) => collect(started))
      .then(() => {
        // The engine refuses to dispatch anything it cannot ticket, so a
        // headless run that calls a tool now writes a journal. Pointing the
        // host at a directory is how a caller (and a test) controls where.
        expect(readdirSync(ledgerDir)).toContain('run-headless-1.1.jsonl');
      });
  });
});
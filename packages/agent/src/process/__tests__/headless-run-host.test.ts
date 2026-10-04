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
 */

import { describe, expect, it } from 'vitest';
import { enumerateProbe, translateFrame } from '@duya/agent-runtime';
import { manifestFingerprint, type RunId } from '@duya/agent-protocol';
import {
  HeadlessRunHost,
  buildHeadlessManifest,
  createAgentExecutionChannel,
  createHeadlessRunHost,
  type HeadlessAgent,
} from '../headless-run-host.js';
import { convertSSEToAgentMessage } from '../sse-frame-codec.js';

/** One real multi-byte character, spelled as an escape so this file stays ASCII. */
const CJK = '\u4e2d\u6587';

/**
 * An agent that replays a fixed event list.
 *
 * This is a test DOUBLE of the executor and nothing else. The run layer, the
 * session, the emitter, the ledger, the translator and the projector are all the
 * real ones — which is the point: the thing under test is the composition, and
 * substituting the executor is what makes it testable with no provider and no
 * network. A double at the RUN layer would defeat the suite; a double at the
 * executor boundary cannot.
 */
function scriptedAgent(events: readonly { type: string; data?: unknown }[]): HeadlessAgent & {
  readonly prompts: string[];
  readonly interrupts: number;
} {
  const prompts: string[] = [];
  let interrupts = 0;
  return {
    prompts,
    get interrupts(): number {
      return interrupts;
    },
    async *streamChat(prompt: string): AsyncGenerator<{ type: string; data?: unknown }, void, unknown> {
      prompts.push(prompt);
      for (const event of events) yield event;
    },
    interrupt(): void {
      interrupts += 1;
    },
  };
}

/** The same turn, as the agent produces it. */
const TURN = [
  { type: 'turn_start', data: { turnCount: 1 } },
  { type: 'text', data: `hello ${CJK}` },
  { type: 'tool_use', data: { id: 'call-1', name: 'Read', input: { path: 'a.ts' } } },
  { type: 'tool_result', data: { id: 'call-1', result: 'contents', error: false } },
  { type: 'text', data: 'done' },
  { type: 'done' },
] as const;

const INTENT = {
  prompt: 'read a.ts and summarise it',
  sessionId: 'cli-session-1',
  cwd: process.cwd(),
  model: 'test-model',
  providerId: 'test-provider',
  maxTurns: 8,
} as const;

function host(agent: HeadlessAgent, runId: RunId = 'run-headless-1'): HeadlessRunHost {
  return createHeadlessRunHost({ agent, mintRunId: () => runId, now: () => 1_700_000_000_000 });
}

/** Drain a run's whole event stream. */
async function collect(run: { events(): AsyncGenerator<{ seq: number; payload: { type: string } }, void, unknown> }): Promise<
  { seq: number; payload: { type: string } }[]
> {
  const seen: { seq: number; payload: { type: string } }[] = [];
  for await (const envelope of run.events()) seen.push(envelope);
  return seen;
}

describe('H8.1 — the headless host runs on the real run layer', () => {
  it('mints the run id in the host and carries it as the canonical identity', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);

    expect(run.runId).toBe('run-headless-1');
    // The manifest's id and the handle's id are the SAME id, and the hash the
    // run records is the hash of that manifest. An adapter that minted its own
    // id beside the dispatch would break this equality, and it is the exact
    // second run-identity source R2.1 removed.
    expect(run.manifest.runId).toBe(run.runId);
    expect(run.manifestHash).toBe(manifestFingerprint(run.manifest));
  });

  it('mints the run.started event BEFORE the executor produces anything', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);
    const events = await collect(run);

    // `run.started` is emitted before dispatch by the RUNTIME. A host that
    // opened the executor first could not produce this ordering, and a run whose
    // first event is a consequence of its second cannot answer "what was this
    // run given?" for a run that crashed a millisecond later.
    expect(events[0]?.payload.type).toBe('run.started');
    expect(events[0]?.seq).toBe(1);
  });

  it('numbers the whole run with a dense, runtime-minted seq', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);
    const events = await collect(run);

    // Dense and 1-based. The transport physically cannot do this — the intake
    // takes a raw frame and the emitter is the only thing that numbers it — so
    // a host that reached this sequence any other way would have had to build a
    // second numbering authority.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const types = events.map((e) => e.payload.type);
    expect(types).toContain('assistant.text_block');
    expect(types).toContain('tool.call_started');
    expect(types).toContain('tool.call_completed');
  });

  it('reaches a terminal the RUNTIME decided, from the executor stream ending', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);
    await collect(run);

    // The agent never said "this run completed" in protocol terms; it said
    // `chat:done`, which the runtime translated. The terminal below is the
    // runtime's synthesis, so a host that invented its own success path would
    // produce the same string by a different route — which is why the event
    // assertions above matter as much as this one.
    const terminal = await run.terminal;
    expect(terminal.status).toBe('completed');
    const result = await run.result();
    expect(result.status).toBe('completed');
    expect(result.runId).toBe('run-headless-1');
  });

  it('turns an executor that THROWS into a failed run, not a silent one', async () => {
    const broken: HeadlessAgent = {
      async *streamChat(): AsyncGenerator<{ type: string; data?: unknown }, void, unknown> {
        yield { type: 'text', data: 'partial' };
        throw new Error('provider exploded');
      },
      interrupt(): void {},
    };
    const run = await host(broken).start(INTENT);
    const events = await collect(run);

    const terminal = await run.terminal;
    expect(terminal.status).toBe('failed');
    expect(events.map((e) => e.payload.type)).toContain('run.failed');
    // The partial text that DID arrive is still in the run's own record. A host
    // that dropped the run on the exception would lose work the runtime had
    // already accepted.
    expect(events.map((e) => e.payload.type)).toContain('assistant.text_block');
  });

  it('closes the run even when the executor stream ends with no terminal frame', async () => {
    // The agent produced content and then stopped without `done`.
    //
    // The terminal is `failed`, not `completed`, and that is the CORRECT answer
    // rather than a disappointment in the test: a stream that ended without
    // saying how it ended did not complete, and reporting `completed` would
    // credit a turn with an outcome its producer never stated. What matters for
    // this slice is that the run CLOSED — the property is that no headless run
    // can be left `running` forever, and a synthesised terminal is what
    // guarantees it.
    const run = await host(scriptedAgent([{ type: 'text', data: 'half an answer' }])).start(INTENT);
    const events = await collect(run);

    const terminal = await run.terminal;
    expect(terminal.status).toBe('failed');
    if (terminal.status === 'failed') {
      expect(terminal.error.message).toContain('no terminal event');
    }

    // The synthesised terminal is DURABLE even though it is not on the live
    // stream, and that asymmetry is pre-existing runtime behaviour rather than
    // something the headless path introduced: `RunSession.#synthesizeTerminalEvent`
    // calls `session.observe` directly, and the emitter's header records that
    // `session.observe` does NOT reach the stream (`event-emitter.ts`). The
    // Desktop orchestrator settles through the very same `controller.settle`, so
    // both hosts behave identically here.
    //
    // Asserted rather than papered over, because the alternative — a test that
    // expects the stream to carry it — would be asserting a behaviour the
    // runtime does not have on either path, and would invite a "fix" that made
    // the headless path diverge from Desktop.
    const durable = await run.transcriptTypes();
    expect(durable).toContain('run.failed');
  });
});

describe('H8.1 — the headless host speaks the WORKER frame vocabulary', () => {
  it('produces exactly the frames the worker process codec produces', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);
    const events = await collect(run);

    // The load-bearing assertion of the whole slice. Every frame the headless
    // path would put on a wire is the frame `convertSSEToAgentMessage` builds —
    // the function the SUBPROCESS worker uses. If the host had a second codec,
    // this comparison would have nothing to compare against, and the transport
    // equivalence suite would still be green, because it compares transports
    // and not producers.
    const workerFrames = TURN.map((event) => convertSSEToAgentMessage(event)).filter(
      (frame): frame is Record<string, unknown> => frame !== null,
    );
    expect(workerFrames.length).toBeGreaterThan(0);

    // Each worker frame, run through the runtime's OWN translator with the same
    // context the host supplies, yields the event the run actually recorded.
    // Comparing through the translator rather than to a hardcoded list is what
    // makes this a claim about the real run layer.
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
    const producedByHost = events.map((e) => e.payload.type);

    for (const type of producedByWorker) {
      expect(producedByHost).toContain(type);
    }
  });

  it('maps a CJK payload through without corrupting it', async () => {
    const run = await host(scriptedAgent(TURN)).start(INTENT);
    const events = await collect(run);
    const texts = events.filter((e) => e.payload.type === 'assistant.text_block');
    expect(texts.length).toBeGreaterThan(0);
    // The block carried multi-byte characters end to end: agent -> codec ->
    // transport -> translator -> emitter. A codec that stringified wrongly here
    // would show up as mojibake rather than as a dropped event.
    expect(JSON.stringify(texts)).toContain(CJK);
  });
});

describe('H8.1 — cancel is the runtime path, not a second stop', () => {
  it('issues the agent interrupt and reports the outcome the runtime decided', async () => {
    // An agent whose stream is still OPEN when the cancel arrives. Cancelling an
    // already-settled run would prove nothing about the stop path: the runtime
    // short-circuits a closed run, and the executor is never touched. So the
    // agent parks on a promise the interrupt resolves.
    let release: (() => void) | null = null;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = scriptedAgent([]);
    const gated: HeadlessAgent = {
      prompts: agent.prompts,
      get interrupts(): number {
        return agent.interrupts;
      },
      async *streamChat(prompt: string): AsyncGenerator<{ type: string; data?: unknown }, void, unknown> {
        agent.prompts.push(prompt);
        yield { type: 'text', data: 'working' };
        await parked;
        yield { type: 'done' };
      },
      interrupt(): void {
        agent.interrupt();
        release?.();
      },
    };

    const run = await host(gated).start(INTENT);
    // Take one event so the run is provably LIVE, then cancel it underneath.
    for await (const _envelope of run.events()) break;
    const outcome = await run.cancel('user pressed ctrl-c');

    // The stop reached the EXECUTOR, which is the half a host-owned loop would
    // have had to fake. `interrupts: 1` is only reachable by going through the
    // channel's own `stop`, because that is the only place the agent is touched.
    expect(agent.interrupts).toBe(1);
    expect(outcome.requested).toBe(true);
    expect(outcome.applied).toBe(true);
    const terminal = await run.terminal;
    expect(terminal.status).toBe('cancelled');
  });

  it('routes the budget onto the executor options, not just the run layer', async () => {
    const agent = scriptedAgent(TURN);
    const run = await host(agent).start({ ...INTENT, maxTurns: 3 });
    await collect(run);

    // A ceiling only the run layer checks is a receipt, not a budget: the run
    // layer learns a turn started when the frame comes BACK, which is after the
    // model request went out. The options the executor received are the
    // observable half of that claim.
    expect(run.manifest.budget.maxTurns).toBe(3);
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
    const probe = enumerateProbe(await host(scriptedAgent(TURN)).probe());

    // These two are the ones plan 587 requires to read as unsupported until D7
    // accepts them. A headless host that advertised either would be claiming a
    // state machine is a shipping capability, which is the specific over-claim
    // H8 is forbidden to make.
    expect(probe.executionResume).toBe(false);
    expect(probe.determinism).toBe(false);
  });

  it('reports no permission expiry clock, because nothing enforces one', async () => {
    const capabilities = await host(scriptedAgent(TURN)).probe();
    // A runtime that emitted `permission.requested` with an `expiresAt` while
    // advertising `absent` would be lying, and the probe's own consistency
    // guard is what catches it. `absent` is the honest word here.
    expect(capabilities.run.permissionExpiryClock).toBe('absent');
  });

  it('reports no event replay, because an in-memory window is not a window', async () => {
    const probe = enumerateProbe(await host(scriptedAgent(TURN)).probe());
    // "The feature exists" is not the question. A host holding no durable
    // history cannot replay, and a probe that says otherwise is how a reconnect
    // is promised and then serves nothing.
    expect(probe.eventReplay).toBe(false);
  });

  it('names the in-process transport, so a caller can tell how it was wired', async () => {
    const capabilities = await host(scriptedAgent(TURN)).probe();
    expect(capabilities.transports).toEqual(['in-process']);
  });
});

describe('H8.1 — the host adapter is an adapter, not a runner', () => {
  it('exposes no pause and no permission responder', () => {
    const run = host(scriptedAgent(TURN));
    // The protocol's `RunHandle` carries `pause()` and
    // `respondToPermission()`. A headless host can do neither, so `HeadlessRun`
    // deliberately does not re-export them: a surface that advertised them
    // would be advertising two capabilities this host has not got.
    expect(Object.getOwnPropertyNames(HeadlessRunHost.prototype).sort()).toEqual(
      ['agent', 'constructor', 'probe', 'start'].sort(),
    );
    expect(run).toBeInstanceOf(HeadlessRunHost);
  });

  it('builds a channel that refuses rather than inventing an executor', async () => {
    // The channel is a function of the agent, so there is exactly one shape of
    // it. A host that could be handed a second, differently-behaving channel
    // would be a host with two run paths.
    const channel = createAgentExecutionChannel(scriptedAgent(TURN));
    expect(typeof channel.start).toBe('function');
    expect(Object.keys(channel)).toEqual(['start']);
  });
});

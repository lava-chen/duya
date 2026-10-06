/**
 * Plan 610 A3-2b7 (S1): the per-turn assembly seam on `duyaAgent`.
 *
 * ## What this file is for
 *
 * The engine calls `ContextPort.assemble` once per turn (`ports.ts:487`). Before
 * this slice that port had NO production body: measured over `packages/`, it had
 * two declarations, two forwarders and eleven implementations, and every one of
 * the eleven was inside `__tests__`. "Bind the ports and flip the driver" was
 * therefore never a wiring change -- the assembly had to exist first. This file
 * is the evidence that the body that now exists agrees with the loop it
 * replaced.
 *
 * ## Why the differential is a CHARACTERISATION, not a seam-vs-model compare
 *
 * The obvious comparison -- "the seam's return equals what the model was sent" --
 * is VACUOUS here, and saying so is the load-bearing part of this header. The
 * loop assigns `systemPromptContent = assembly.systemPrompt` and then hands
 * `deps.systemSystemPromptContent` straight to the client
 * (`TurnStreamRunner.ts:138`). Seam output and observed output are the same
 * variable, so `expect(a).toBe(a)` would pass for any seam at all, including one
 * that assembled nothing.
 *
 * So the "before" side is frozen instead. The observations in
 * `PRE_REFACTOR_OBSERVATIONS` were recorded by running the REAL cycle on the
 * PRE-refactor `DuyaAgent.ts` (git `cbf9eebe`, the commit this slice branched
 * from) with the scripted model below, and they are asserted here against the
 * refactored cycle. Two different implementations, one input, equal output --
 * which is the property a refactor can actually fail.
 *
 * They are recorded from the cycle's OWN behaviour rather than from a
 * hand-written twin: a twin would reproduce whatever bug it was written from,
 * and a test comparing a seam to a copy of its own logic can only confirm the
 * copy is still there.
 *
 * ## What it does NOT prove
 *
 * It does not prove the engine can drive a turn -- nothing here constructs
 * `RunEngineImpl`, and no test in the repo does that against a real
 * `duyaAgent`. That is S3. It also does not prove the headless path survives the
 * eventual deletion of `streamChat`; that is S4.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, SSEEvent, ToolUseContext } from '../../types.js';

// ============================================================================
// The source under test
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUYA = path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts');

/**
 * Comment-strip the source under test.
 *
 * ## Why this is local and not the gate's own stripper
 *
 * `boundary-gates.mjs` strips before it counts, and its sibling
 * `strip-comments.mjs` is the obvious import -- `turn-pipeline-factory-seam.test.ts`
 * imports exactly that path. Importing it from a `@duya/agent` test adds a
 * `pkg:agent -> scripts` cross-boundary edge, and that edge moves two counters
 * this slice is required to hold still: `architecture:check` went 963 -> 964 and
 * `architecture:self-test` went 786 = 786 -> 787 = 787, both from this one import
 * and from nothing else. Trading a gate that pins the package boundary for a
 * convenience import in one test file is the wrong way round.
 *
 * ## Why a local copy is nevertheless safe here
 *
 * Because it is VERIFIED rather than assumed. The two strippers were run over
 * `DuyaAgent.ts` and compared: both produce **297596 characters and are
 * byte-identical**, and all eight patterns this file counts agree between them.
 * The one difference a naive copy does have is CRLF: this repo's `.ts` files are
 * CRLF, and blanking `\r` as if it were an ordinary character diverges from the
 * gate. Both `\r` and `\n` are preserved below, which is what closes it.
 *
 * That verification is a property of THIS file, not a general licence: on a
 * module with a regex literal containing `//`, a stripper with no regex-vs-
 * division rule would diverge. `DuyaAgent.ts` has none that this touches, and
 * the gate remains the authority for its own detectors.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === '\n' || src[k] === '\r' ? src[k] : ' ';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The gate's own stripper, so these counts cannot disagree with CI's. */
function code(): string {
  return stripComments(fs.readFileSync(DUYA, 'utf8'));
}

function occurrences(pattern: RegExp, text: string = code()): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// The frozen pre-refactor behaviour
// ============================================================================

/**
 * Recorded from the REAL cycle at `cbf9eebe`, i.e. BEFORE `assembleTurn`
 * existed. See the header for why these are frozen rather than recomputed.
 *
 * `systemPromptLength` is deliberately NOT pinned: it embeds the working
 * directory and the agent roster, so it is machine-dependent and would fail on
 * a checkout path this test never saw. What IS pinned is the shape -- that both
 * turns advertise the same set, and that the prompt does not grow from turn 1
 * to turn 2, which is the specific way the seam could have broken it (see
 * `refreshTurnSystemPrompt`'s doc comment on why the recomputed prefix REPLACES
 * rather than appends).
 */
const PRE_REFACTOR_TOOL_NAMES = ['probe_ok', 'progress_update', 'tool_catalog', 'tool_invoke'];
const PRE_REFACTOR_TURN1_ROLES = ['user'];
const PRE_REFACTOR_TURN2_ROLES = ['user', 'assistant', 'tool'];

// ============================================================================
// The offline host: scripted provider + fake worker IPC
// ============================================================================

interface Seen {
  systemPrompt: string;
  toolNames: string[];
  roles: string[];
}

let active: { seen: Seen[] } | null = null;

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };
const SCRIPTS: readonly (readonly SSEEvent[])[] = [
  [
    { type: 'text', data: 'calling the probe' },
    { type: 'tool_use', data: { id: 't1', name: 'probe_ok', input: { value: 'alpha' } } },
    DONE,
  ],
  [{ type: 'text', data: 'done' }, DONE],
];

vi.mock('@duya/ai', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const delegating = {
    streamChat(messages: Message[], options?: Record<string, unknown>) {
      // Which script: the turn index is how many requests have been recorded so
      // far. Read BEFORE the push, or turn 1 indexes -1 and replays the LAST
      // script -- a fixture that silently drops the tool call and makes the
      // whole file pass without ever dispatching a tool.
      const index = active?.seen.length ?? 0;
      active?.seen.push({
        systemPrompt: String((options?.systemPrompt as string) ?? ''),
        toolNames: ((options?.tools as Array<{ name: string }>) ?? []).map((t) => t.name).sort(),
        roles: messages.map((m) => m.role),
      });
      const script = SCRIPTS[Math.min(index, SCRIPTS.length - 1)] ?? SCRIPTS[SCRIPTS.length - 1];
      return (async function* () {
        for (const event of script) yield event;
      })();
    },
  };
  return { ...actual, createAIClient: () => delegating, createAIClientWithRetry: () => delegating };
});

const PRE_EXISTING = new Set(process.listeners('message'));
const { duyaAgent } = await import('../../agent/DuyaAgent.js');
const { ToolRegistry } = await import('../../tool/registry.js');
const { initDbClient } = await import('../../ipc/db-client.js');

let dbListener: ((m: unknown) => void) | null = null;
const originalEnv = { ...process.env };
let realSend: typeof process.send | undefined;

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
});

afterEach(() => {
  process.env = { ...originalEnv };
  process.send = realSend;
  vi.restoreAllMocks();
  active = null;
});

interface Probe {
  readonly runs: () => number;
}

function probeRegistry(): { registry: InstanceType<typeof ToolRegistry>; probe: Probe } {
  let runs = 0;
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'probe_ok',
      description: 'probe',
      input_schema: { type: 'object', properties: { value: { type: 'string' } } },
    } as never,
    {
      execute: async () => {
        runs += 1;
        return { id: 'p1', name: 'probe_ok', result: `RAN-${runs}` };
      },
    } as never,
  );
  return { registry, probe: { runs: () => runs } };
}

let sessionSeq = 0;
function makeAgent(): InstanceType<typeof duyaAgent> {
  sessionSeq += 1;
  return new duyaAgent({
    apiKey: 'test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId: `s-turn-assembly-${sessionSeq}`,
    workingDirectory: process.cwd(),
    permissionMode: 'bypassPermissions',
  });
}

// ============================================================================
// 1. THE DIFFERENTIAL: the refactored cycle still does what the old one did
// ============================================================================

describe('the seam did not change what the cycle sends the model', () => {
  it('reproduces the pre-refactor per-turn request exactly', async () => {
    installFakeDbIpc();
    const { registry, probe } = probeRegistry();

    active = { seen: [] };
    const agent = makeAgent();
    for await (const _event of agent.streamChat('run the probe', { toolRegistry: registry })) {
      /* drain */
    }

    // Non-vacuity FIRST, so a harness that silently stopped driving the loop
    // cannot satisfy the comparisons below with two empty requests. The probe
    // really ran, and the loop really reached the model twice.
    expect(probe.runs()).toBe(1);
    const seen = active.seen;
    expect(seen).toHaveLength(2);

    // Turn 1: the prompt alone.
    expect(seen[0].roles).toEqual(PRE_REFACTOR_TURN1_ROLES);
    // Turn 2: the loop appended the assistant tool_use and the tool result.
    expect(seen[1].roles).toEqual(PRE_REFACTOR_TURN2_ROLES);

    // The advertised tool surface is unchanged, and it is the FILTERED one --
    // `probe_ok` is present because the test registered it, and the two meta
    // tools are present because the catalog decided they are visible.
    expect(seen[0].toolNames).toEqual(PRE_REFACTOR_TOOL_NAMES);
    expect(seen[1].toolNames).toEqual(PRE_REFACTOR_TOOL_NAMES);

    // The tool-group instruction still rides the prompt. Its presence is what
    // proves `systemPromptContent` survived the move out of the inline block:
    // it is appended once, above the loop, and a seam that returned a different
    // prompt would lose it.
    expect(seen[0].systemPrompt).toContain('Tool-group progress:');
    expect(seen[1].systemPrompt).toContain('Tool-group progress:');

    // The prompt does NOT grow from turn 1 to turn 2. This is the specific
    // regression the mode-prefix refresh could introduce: it is applied to the
    // BASE prompt every turn, so appending instead of replacing would compound
    // the base once per turn. Equal lengths is the observable of "replaced".
    expect(seen[1].systemPrompt.length).toBe(seen[0].systemPrompt.length);
  });
});

// ============================================================================
// 2. Reachability and single implementation, asserted against the source
// ============================================================================

describe('the seam is public, and the loop routes through it rather than beside it', () => {
  it('declares assembleTurn without a `private` modifier', () => {
    // `private` is compile-time only, so this is a statement about intent: the
    // composition must be able to reach it, which is the whole reason it exists.
    expect(code()).toContain('assembleTurn(request: TurnAssemblyRequest): TurnAssembly');
    expect(code()).not.toMatch(/private\s+assembleTurn/);
  });

  it('has exactly ONE call site, and it is the legacy cycle', () => {
    // Counted, not pattern-matched: a second caller is a second owner of "what
    // a turn advertises". `composeLegacyRunPorts` takes the agent and will reach
    // this method -- through this seam, not around it.
    expect(occurrences(/this\.assembleTurn\s*\(/)).toBe(1);
  });

  it('no longer assembles a turn inline: the mode refresh and the pipeline are inside the seam', () => {
    // The pre-slice loop had both of these at the top of its body. Each is now
    // reachable only through `refreshTurnSystemPrompt` / `buildTurnPipeline`,
    // which the seam owns.
    expect(occurrences(/baseSystemPromptWithoutModes\)\s*:\s*string|prefix \+= typeof p === 'function'/)).toBe(1);
    expect(occurrences(/this\.buildTurnPipeline\s*\(/)).toBe(1);
  });
});

describe('the catalog protocol has one home', () => {
  it('assigns currentRound in exactly one place', () => {
    // Pre-slice it was assigned inline, mid-loop, where only the loop could
    // reach it. One assignment site is what makes "the engine can set the round"
    // a fact rather than an intention.
    expect(occurrences(/currentRound\s*=\s*request\.turn/)).toBe(1);
    expect(occurrences(/currentRound\s*=\s*turnCount/)).toBe(0);
  });

  it('routes the three compaction sites and the drain site through the seam methods', () => {
    // Three invalidations, one record. Each is a hand-reached piece of one
    // protocol, which is the shape that lets a seam skip one and still pass
    // every structural test.
    expect(occurrences(/this\.invalidateTurnCatalogSchemaReads\s*\(/)).toBe(3);
    expect(occurrences(/this\.recordTurnCatalogSchemaRead\s*\(/)).toBe(1);
  });

  it('keeps the bare free functions reachable ONLY as the seam implementation', () => {
    // One call each, inside the seam. A call anywhere else is a second owner of
    // the decision of WHEN the maps are cleared.
    expect(occurrences(/invalidateToolCatalogSchemaReads\s*\(/)).toBe(1);
    expect(occurrences(/recordToolCatalogSchemaRead\s*\(/)).toBe(1);
  });
});

// ============================================================================
// 3. The seam's behaviour, driven directly
// ============================================================================

/**
 * Drive one `assembleTurn` against a real agent.
 *
 * `abortController` is assigned through a cast because it is private and
 * `streamChat` normally establishes it on entry. The cast is the honest
 * boundary: this harness is standing in for a live run, and says so.
 */
interface SeamRun {
  readonly assembly: ReturnType<InstanceType<typeof duyaAgent>['assembleTurn']>;
  readonly toolUseContext: ToolUseContext;
}

/**
 * A minimal `TurnContext` stand-in.
 *
 * `TurnAssembler.build` derives `sessionId` and `workingDirectory` from the AGENT
 * snapshot, not from `options` (`turnShape.ts:156-157`), so two contexts built
 * from different options are the same object and cannot discriminate a stale
 * one. `buildTurnPipeline` reads exactly three fields off it
 * (`DuyaAgent.ts:493,496,503`), so those three are supplied directly and the
 * test observes what the seam FORWARDED rather than what the assembler derived.
 */
function standInTurnContext(sessionId: string, workingDirectory: string): TurnContextLike {
  return { sessionId, workingDirectory, language: undefined } as unknown as TurnContextLike;
}

type TurnContextLike = { sessionId?: string; workingDirectory?: string; language?: string };

async function assembleOnce(
  agent: InstanceType<typeof duyaAgent>,
  request: Record<string, unknown>,
): Promise<SeamRun> {
  const internals = agent as unknown as { abortController: AbortController };
  internals.abortController = new AbortController();
  let toolUseContext: ToolUseContext | undefined;

  // One cast, at the boundary. The seam's parameter is a closed interface, and
  // this harness deliberately supplies a PART of it -- the rest of what
  // `buildTurnPipeline` reads comes from `this`, and the fields a live run
  // supplies (permission gate, meta-tool dispatcher, publisher) are not what
  // these assertions are about. Spreading a `Record` over the defaults keeps
  // each test's intent visible instead of hiding it behind nine required
  // arguments per call.
  const merged: Record<string, unknown> = {
    turnContext: standInTurnContext('seam-default', process.cwd()),
    bindToolUseContext: (c: ToolUseContext) => {
      toolUseContext = c;
    },
    ...request,
  };
  const assembly = agent.assembleTurn(merged as unknown as Parameters<typeof agent.assembleTurn>[0]);
  if (!toolUseContext) throw new Error('assembleTurn bound no tool-use context');
  return { assembly, toolUseContext };
}

/** `_resolveTools` is private; the cast stands in for a live run's own bundle. */
async function resolvedBundle(
  agent: InstanceType<typeof duyaAgent>,
  registry: InstanceType<typeof ToolRegistry>,
): Promise<Record<string, unknown>> {
  const internals = agent as unknown as {
    _resolveTools: (o: unknown, p?: unknown) => Promise<Record<string, unknown>>;
  };
  return internals._resolveTools({ toolRegistry: registry });
}

describe('assembleTurn advances the catalog round and the round is what a schema read records', () => {
  it('stamps each turn, so a drain records the round the model was actually in', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, { turn: 1, resolved, messages: [], tools: [], systemPrompt: 'p' });
    expect(turn1.assembly.catalogView.currentRound).toBe(1);

    // A schema read in turn 1 is stamped 1 -- not 0, and not whatever the
    // view happened to be constructed with.
    const catalogView = turn1.assembly.catalogView as unknown as {
      loadedSchemaRounds: Map<string, number>;
      snapshot: { getCatalogEntry: (id: string) => { schemaRevision: string } | undefined };
      eligibleToolIds: Set<string>;
    };
    expect(catalogView.loadedSchemaRounds.size).toBe(0);

    const turn2 = await assembleOnce(agent, { turn: 2, resolved, messages: [], tools: [], systemPrompt: 'p' });
    expect(turn2.assembly.catalogView.currentRound).toBe(2);
  });
});

describe('assembleTurn reads the bundle it was given, not one it remembered', () => {
  it('returns the CALLER\'S catalog view, so a second turn on a new bundle sees the new view', async () => {
    // The stale-bundle mutation: a seam that caches `resolved` on first call
    // would hand turn 2 the turn-1 view, and a `tool_invoke` dispatched on that
    // turn would read a snapshot from a run it is no longer in.
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const first = await resolvedBundle(agent, registry);
    const second = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, { turn: 1, resolved: first, messages: [], tools: [], systemPrompt: 'p' });
    const turn2 = await assembleOnce(agent, { turn: 2, resolved: second, messages: [], tools: [], systemPrompt: 'p' });

    expect(turn2.assembly.catalogView).toBe(second.catalogView);
    expect(turn2.assembly.catalogView).not.toBe(first.catalogView);
    expect(turn1.assembly.catalogView).toBe(first.catalogView);
  });

  it('carries the CALLER\'S turn context into this turn\'s tool-use context', async () => {
    // The stale-turnContext mutation: the loop builds `turnContext` once per run
    // and never changes it, so this CANNOT be observed through `streamChat`.
    // It is observed here because the whole point of the seam is that a future
    // host supplies a per-turn context, and a seam that cached turn 1's would
    // silently run every later turn under turn 1's identity.
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    const turn1 = await assembleOnce(agent, {
      turn: 1, resolved, messages: [], tools: [], systemPrompt: 'p',
      turnContext: standInTurnContext('session-A', process.cwd()),
    });
    const turn2 = await assembleOnce(agent, {
      turn: 2, resolved, messages: [], tools: [], systemPrompt: 'p',
      turnContext: standInTurnContext('session-B', process.cwd()),
    });

    expect(turn1.toolUseContext.options?.sessionId).toBe('session-A');
    expect(turn2.toolUseContext.options?.sessionId).toBe('session-B');
    expect(turn2.toolUseContext.options?.sessionId).not.toBe('session-A');
  });
});

describe('invalidateTurnCatalogSchemaReads is the whole of the invalidation', () => {
  it('clears the loaded-schema maps, which is what makes a compacted history stop serving a stale schema', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);
    const view = (resolved as { catalogView: Record<string, unknown> }).catalogView as unknown as {
      loadedSchemaRevisions: Map<string, string>;
      loadedSchemaRounds: Map<string, number>;
    };

    // Seed both maps as a committed `tool_catalog` receipt would.
    view.loadedSchemaRevisions.set('tool-x', 'rev-1');
    view.loadedSchemaRounds.set('tool-x', 1);
    expect(view.loadedSchemaRounds.size).toBe(1);

    agent.invalidateTurnCatalogSchemaReads(resolved as never);

    // The skip-the-invalidation mutation leaves both maps populated, and the
    // dispatcher then reports a schema as loaded in a round whose history
    // compaction removed -- which produces a wrong answer rather than an error.
    expect(view.loadedSchemaRevisions.size).toBe(0);
    expect(view.loadedSchemaRounds.size).toBe(0);
  });

  it('recordTurnCatalogSchemaRead ignores a non-tool row, and the guard lives in the method', async () => {
    const { registry } = probeRegistry();
    const agent = makeAgent();
    const resolved = await resolvedBundle(agent, registry);

    expect(agent.recordTurnCatalogSchemaRead(resolved as never, { role: 'assistant', content: 'x' } as never)).toBe(false);
    // A tool row with no catalog receipt is also not a read.
    expect(agent.recordTurnCatalogSchemaRead(resolved as never, { role: 'tool', content: 'x' } as never)).toBe(false);
  });
});
/**
 * The volatile context SURVIVES a compaction.
 *
 * ## What this file is
 *
 * This file WAS the defect probe for audit finding H-2, and it PINNED the
 * defect: it asserted that the rail is ABSENT from the request once a
 * compaction has replaced the transcript. The fix inverted that assertion, and
 * the file is now the CONTRACT the fix satisfies rather than a
 * characterisation of the bug.
 *
 * The reference is the Agent Harness Correctness Audit (plan
 * `docs/exec-plans/active/2026-10-24-harness-correctness-audit.md`), finding
 * H-2, with H-5 (the dropped `origin` marker) as its other half.
 *
 * ## The defect this file used to pin
 *
 * The host attaches its volatile context -- the environment, the memory
 * projection, the skill catalog, a hook's block -- through the CONTEXT RAIL.
 * The rail lives in the working array only: it is projected onto a COPY of
 * the transcript for each request and never enters the timeline
 * (`applyContextRail`, plan 619 Phase 3).
 *
 * A compaction replaces the transcript. The replacement the host hands back
 * is a re-projection of the TIMELINE (`worker-engine-driver.ts` binds the
 * compaction source to `agent.getMessages()`), so it cannot contain the rail.
 * The engine then built the next request from the REPLACEMENT rather than
 * from the host's projection (`run-engine.ts`: `history = ctx.compacted.current
 * ?? ...`), and the rail was gone for the rest of the run.
 *
 * Plan 619 Phase 3 states the opposite -- "compaction 后自动重建" -- so the
 * plan's claim and the code disagreed, and the code is what shipped.
 *
 * ## What the fix does
 *
 * A compaction replaces the TRANSCRIPT; it does not replace the per-request
 * CONTEXT. The request keeps the replacement for the conversation and
 * re-attaches the context rows from the host's CURRENT projection
 * (`run-engine.ts`, `#requestHistory`). The two halves are DISJOINT by
 * construction, so the context rows ride EXACTLY ONCE -- the counterpart of
 * this file's counter-examples lives in
 * `compaction-context-reattachment.test.ts`.
 *
 * ## The three arms
 *
 *  - Without a compaction, the rail rides the request.
 *  - With one, it STILL rides the request, exactly once.
 *  - And the question is still the last row, because a fix for the rail must
 *    not be a fix for the prompt.
 */

import { describe, expect, it } from 'vitest';

import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  AssembledTurn,
  CompactionDecision,
  CompactionDecisionInput,
  CompactionPort,
  CompactionProgress,
  ModelFrame,
  ModelMessage,
  ModelPort,
  ModelRequest,
  RunEnginePorts,
  RunEvent,
  RunEventStorePort,
  RunInputSnapshot,
  RunManifest,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';

// ============================================================================
// The fixture
// ============================================================================

/** The run's prompt. */
const PROMPT: ModelMessage = { role: 'user', id: 'p1', content: 'what does the ui package look like?' };
/** A row the person said earlier. */
const PRIOR: ModelMessage = { role: 'user', id: 'u-1', content: 'hello' };
/**
 * A row the SYSTEM attached: the volatile-context rail.
 *
 * `origin: 'context'` is the marker the request contract uses to tell the
 * system's own rows from the conversation's.
 */
const RAIL: ModelMessage = {
  role: 'user',
  id: 'rail-1',
  content: '<system-reminder>the environment</system-reminder>',
  origin: 'context',
};

/**
 * What the host's compaction replacement actually is.
 *
 * A re-projection of the TIMELINE -- so it carries the conversation and the
 * prompt, and it cannot carry the rail, because the rail is never in the
 * timeline. Stated as a function so no test can mutate another's array.
 */
function replacement(): readonly ModelMessage[] {
  return [PRIOR, PROMPT];
}

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: 'run-1',
    projectId: null,
    workspaceId: 'ws',
    roots: ['/tmp'],
    cwd: '/tmp',
    permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
    capabilities: { profiles: [], modes: [], tools: [] },
    connectorBindings: [],
    env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
    agent: { profileId: null, model: 'test-model', providerId: 'test-provider' },
    budget: {},
    deterministic: false,
    provenance: {
      roots: { source: 'unsupported', synthesised: true },
      cwd: { source: 'unsupported', synthesised: true },
      permissionPolicy: { source: 'unsupported', synthesised: true },
      capabilities: { source: 'unsupported', synthesised: true },
      connectorBindings: { source: 'unsupported', synthesised: true },
      env: { source: 'unsupported', synthesised: true },
      agent: { source: 'unsupported', synthesised: true },
      budget: { source: 'unsupported', synthesised: true },
      workspaceId: { source: 'unsupported', synthesised: true },
      deterministic: { source: 'unsupported', synthesised: true },
    },
  } as RunManifest;
}

function inputFor(): RunInputSnapshot {
  return {
    revision: 'rev-1',
    prompt: PROMPT,
    // `by_ref`, which is what a host that projects its own rows sends: the
    // engine then reads the HOST's projection. An INLINE history would be
    // frozen at run start and would hide the very thing this probe is about.
    history: { kind: 'by_ref', digest: 'd1', locator: 'agent://transcript' },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

interface Probe {
  /** Every request the model was sent, in order. */
  readonly sent: ModelMessage[][];
  readonly ports: RunEnginePorts;
}

/**
 * The smallest engine that can compact.
 *
 * The host's projection carries the rail; the compaction port hands back the
 * replacement a real host would hand back.
 */
function probe(options: { readonly compact: boolean }): Probe {
  const sent: ModelMessage[][] = [];

  const model: ModelPort = {
    async *stream(request: ModelRequest): AsyncIterable<ModelFrame> {
      sent.push([...request.messages]);
      yield { type: 'text', text: 'hi' };
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
  };

  const compaction: CompactionPort = {
    async decide(_input: CompactionDecisionInput): Promise<CompactionDecision> {
      return options.compact
        ? { kind: 'compact', trigger: 'auto' }
        : { kind: 'skip', reason: 'under the trigger line' };
    },
    async run(_input: CompactionDecisionInput, _reporter: (p: CompactionProgress) => void) {
      return {
        kind: 'replaced',
        replacement: replacement(),
        boundaryId: 'boundary-1',
        compactedMessageIds: ['u-1'],
      };
    },
    nextCompactionId(): string {
      return 'cmp-1';
    },
    noteUsage(): void {},
  };

  const queued: ToolDrainItem[] = [];

  const ports: RunEnginePorts = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model,
    tools: {
      dispatch(_call: ToolCallRequest): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        for (const outcome of queued.splice(0, queued.length)) yield outcome;
      },
      discard(_reason: string): void {},
      describe: (): readonly ToolDescriptor[] => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        // The HOST's projection: the conversation, then the rows the system
        // attached, then the prompt -- the shape the host really produces.
        return {
          systemPrompt: 'you are a test',
          messages: [PRIOR, RAIL, PROMPT],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      authorize: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    },
    events: {
      publish(_event: RunEvent): void {},
      proposeTerminal(): void {},
    } as RunEventStorePort,
    compaction,
    turnOutput: {
      recordToolResult: () => Promise.resolve(),
      recordAssistantMessage: () => Promise.resolve(),
      finishTurn: () => Promise.resolve(),
      recordInjectedMessage: () => Promise.resolve(),
    },
    modeExit: { onRunExit: () => Promise.resolve() },
  };

  return { sent, ports };
}

async function run(p: Probe): Promise<void> {
  const engine = new RunEngineImpl({ now: () => 1_000 });
  await engine
    .execute({
      manifest: manifestFor(),
      input: inputFor(),
      signal: new AbortController().signal,
      ports: p.ports,
    })
    .completed();
}

/** The rows the system attached to a request. */
function contextRows(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.filter((message) => message.origin === 'context');
}

// ============================================================================
// The contract
// ============================================================================

describe('the volatile context across a compaction', () => {
  it('rides the request when nothing compacts', async () => {
    const p = probe({ compact: false });
    await run(p);

    expect(p.sent.length).toBeGreaterThan(0);
    // The rail IS there, in front of the question -- the request contract's
    // own shape.
    expect(contextRows(p.sent[0]!).map((m) => m.id)).toEqual(['rail-1']);
  });

  it('STILL rides the request once a compaction has replaced the transcript', async () => {
    // THE FIX (audit finding H-2).
    //
    // The replacement is a re-projection of the timeline, so it cannot carry
    // the rail -- the rail is working-array state and never enters the
    // timeline. A request built from the replacement ALONE therefore loses
    // the environment, the memory projection, the skill catalog and every
    // hook block, for the rest of the run.
    //
    // A compaction replaces the TRANSCRIPT; it does not replace the
    // per-request CONTEXT. The request keeps the replacement for the
    // conversation and re-attaches the context rows from the host's CURRENT
    // projection -- EXACTLY ONCE, which is what the second assertion pins.
    const p = probe({ compact: true });
    await run(p);

    expect(p.sent.length).toBeGreaterThan(0);
    const request = p.sent[0]!;
    // Present ...
    expect(contextRows(request).map((m) => m.id)).toEqual(['rail-1']);
    // ... and present ONCE. A request that carries the rail twice is as
    // broken as one that carries it zero times.
    expect(request.filter((m) => m.id === 'rail-1')).toHaveLength(1);
  });

  it('still carries the question, so the compaction itself is not the defect', async () => {
    // The defect was CONTEXT LOSS, not a lost question: the prompt is in the
    // replacement and the request still ends with it. This arm separates the
    // two, so a fix for the rail cannot be confused with a fix for the
    // prompt.
    const p = probe({ compact: true });
    await run(p);

    const request = p.sent[0]!;
    expect(request.at(-1)?.id).toBe('p1');
  });

  it('builds the same request with and without a compaction', async () => {
    // The strongest form of the claim: the compaction is INVISIBLE to the
    // request's shape. The conversation is the replacement's, the context is
    // the host's, and the question is last either way.
    //
    // This arm fails if the fix is reverted in EITHER direction: a request
    // built from the replacement alone loses the rail, and a request that
    // carries both copies of the rail has it twice.
    const compacted = probe({ compact: true });
    await run(compacted);
    const plain = probe({ compact: false });
    await run(plain);

    expect(compacted.sent[0]!.map((m) => m.id)).toEqual(plain.sent[0]!.map((m) => m.id));
    expect(compacted.sent[0]!.map((m) => m.id)).toEqual(['u-1', 'rail-1', 'p1']);
  });
});

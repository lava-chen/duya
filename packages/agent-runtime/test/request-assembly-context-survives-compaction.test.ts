/**
 * DEFECT PROBE -- the volatile context does NOT survive a compaction.
 *
 * ## What this file is
 *
 * A CHARACTERISATION test, not a contract test: it pins the CURRENT
 * behaviour, and the current behaviour is a defect. It exists so the defect
 * is visible in the test report instead of in a bug report, and so the
 * assertion can be flipped the moment the defect is fixed.
 *
 * The reference is the Agent Harness Correctness Audit (plan
 * `docs/exec-plans/active/2026-10-24-harness-correctness-audit.md`), finding
 * H-2.
 *
 * ## The defect
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
 * The engine then builds the next request from the REPLACEMENT rather than
 * from the host's projection (`run-engine.ts`: `history = ctx.compacted.current
 * ?? ...`), and the rail is gone.
 *
 * Plan 619 Phase 3 states the opposite -- "compaction 后自动重建" -- so the
 * plan's claim and the code disagree, and the code is what ships.
 *
 * ## What the two arms show
 *
 *  - Without a compaction, the rail rides the request.
 *  - With one, it does not. Same host, same prompt, same engine.
 *
 * The second arm is the defect; the first arm is what makes the second one
 * mean something rather than "the rail is never there".
 *
 * ## What the fix has to decide
 *
 * The rail is per-request state, so a compaction cannot "preserve" it the
 * way it preserves transcript rows -- it has to be re-PROJECTED onto the
 * replacement. That is a change to where the rail is applied, not to what
 * it contains, and it belongs to whoever owns the compaction replacement.
 * This file does not propose the fix; it pins the fact that the fix is
 * needed.
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
// The probe
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

  it('DOES NOT ride the request once a compaction has replaced the transcript', async () => {
    // THE DEFECT (audit finding H-2).
    //
    // The replacement is a re-projection of the timeline, so it cannot carry
    // the rail -- the rail is working-array state and never enters the
    // timeline. The engine builds the request from the replacement, so the
    // request loses the environment, the memory projection, the skill
    // catalog and every hook block, for the rest of the run.
    //
    // When this is fixed, this assertion INVERTS: the rail is present, and
    // the arm above is what proves the rail is reachable at all.
    const p = probe({ compact: true });
    await run(p);

    expect(p.sent.length).toBeGreaterThan(0);
    expect(contextRows(p.sent[0]!)).toEqual([]);
  });

  it('still carries the question, so the compaction itself is not the defect', async () => {
    // The defect is CONTEXT LOSS, not a lost question: the prompt is in the
    // replacement and the request still ends with it. This arm separates the
    // two, so a fix for the rail cannot be confused with a fix for the
    // prompt.
    const p = probe({ compact: true });
    await run(p);

    const request = p.sent[0]!;
    expect(request.at(-1)?.id).toBe('p1');
  });
});

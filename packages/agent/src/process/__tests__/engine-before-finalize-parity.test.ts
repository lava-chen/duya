/**
 * Plan 610 D2: is `before_finalize`'s unread text a defect, or faithful parity?
 *
 * ## The question, and why it had two answers in the tree
 *
 * One slice said `before_finalize` is "a dead end -- a vetoing contributor
 * re-opens the loop, but its text goes to a rail no request reads". An earlier
 * slice said the opposite: that this MATCHES the legacy, whose
 * `SessionFinalizer` also drops a non-vetoing `PreFinalize` inject.
 *
 * Both claims are in the tree. This file settles it by MEASURING BOTH PATHS
 * rather than by picking the more plausible reading of a comment, because the
 * whole question is whether the engine agrees with the legacy, and a test that
 * only drove the engine could not tell the difference between "the engine is
 * faithful" and "the engine happens to match".
 *
 * ## The measured answer: PARITY. The legacy drops it too.
 *
 * The legacy's `LoopHookBus` declares, per event, which effect types are
 * honoured, and `PreFinalize` accepts exactly one: `block_finalize`. A handler
 * that returns an `inject` at `PreFinalize` is therefore DISCARDED BY THE BUS,
 * before `SessionFinalizer.finalizeSuccess` ever sees the effect list. So the
 * legacy cannot deliver a non-vetoing `PreFinalize` inject to the model at all
 * -- not "usually", not "on some paths": there is no code path that does it.
 *
 * And when a veto DOES arrive, the legacy applies it to `messages` and returns
 * `false`, which is the "re-open the loop" behaviour the first claim describes.
 * So the veto half of the claim is right and the text half is not a divergence
 * at all -- it is the same dead end on both sides.
 *
 * ## What is asserted here, and against what source
 *
 * - LEGACY half: a real `LoopHookBus`, dispatched for real. The assertion is on
 *   what the bus RETURNED.
 * - ENGINE half: a real `RunEngineImpl` over real ports, with a real
 *   `before_finalize` contributor. Asserted on the fragments the host was
 *   handed through `ports.context.defer` -- the ACTION -- rather than on the
 *   transcript, because for a phase whose text nobody reads, the transcript is
 *   empty under BOTH a correct implementation and a broken one.
 *
 * The comparison that makes this a parity verdict rather than two unrelated
 * facts is the third assertion: the engine's outcome for a non-vetoing
 * contribution is the SAME SHAPE as the legacy's, and the reason the engine
 * still adopts onto the deferred rail is that a vetoing run DOES come back for
 * another turn and reads it.
 *
 * ## Why this file lives HERE and not under `packages/agent-runtime/tests`
 *
 * It was written there first, and that location cannot hold it. The test needs
 * the agent's OWN bus, and `pkg:agent-runtime` is a managed module with a
 * one-way dependency on `pkg:agent`: importing `../../agent/src/hooks/loop.js`
 * from `packages/agent-runtime/tests/` is a `module-dependency` violation in a
 * managed module, which is the one thing `architecture-check.mjs` blocks with
 * no tolerance. A test that cannot live inside the boundary has to live where
 * the boundary already points, and `pkg:agent -> pkg:agent-runtime` is the
 * direction the product's own cross-path proofs already use.
 *
 * So the measurement did not change and neither did its verdict -- only the
 * directory. Worth recording because the failure mode is silent: the test was
 * green, and only `npm run architecture:check` knew it did not belong.
 *
 * ## Why no behaviour is changed here
 *
 * Because parity is the goal and the engine already has it. The engine is in
 * fact MORE generous than the legacy in one respect -- it accepts an
 * `inject` at `before_finalize` where the legacy's bus would drop it -- and that
 * generosity is harmless precisely because a non-vetoing contribution on a run
 * that FINALIZES is read by nobody on either path. Widening the legacy's bus to
 * match would be a behaviour change to the shipped product in the direction
 * nobody asked for, and this slice's mandate is parity, not improvement.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ExtensionContribution,
  ExtensionContributor,
  ExtensionContext,
  ExtensionPort,
  ModelFrame,
  ModelPort,
  RunEnginePorts,
  RunExecutionRequest,
  RunInputSnapshot,
  ToolCallRequest,
  ToolDescriptor,
  ToolDrainItem,
  TransientContextFragment,
} from '@duya/agent-runtime';
import type { RunId, RunManifest } from '@duya/agent-protocol';

// ============================================================================
// The LEGACY half: the real bus the finalizer dispatches on
// ============================================================================

const PRE_FINALIZE_TEXT = 'a PreFinalize inject that does not veto';

/**
 * Drive the REAL `LoopHookBus` the way `SessionFinalizer.finalizeSuccess`
 * does, with a handler that returns exactly the shape the first claim
 * describes: a non-vetoing `inject` at `PreFinalize`.
 *
 * The import is of the PRODUCT's bus, not of a copy. A hand-rolled stand-in
 * would prove that a stand-in drops what a stand-in drops.
 */
async function legacyBusOutcome(): Promise<readonly { readonly type: string }[]> {
  const { LoopHookBus } = await import('../../hooks/loop.js');
  const bus = new LoopHookBus();
  bus.register({
    id: 'probe.inject',
    events: ['PreFinalize'],
    priority: 10,
    handler: () => ({ type: 'inject' as const, injection: PRE_FINALIZE_TEXT, source: 'custom' as const }),
  });
  return bus.dispatch('PreFinalize', {
    sessionId: 's-legacy',
    turnCount: 1,
    seqIndex: 1,
    messages: [],
  });
}

// ============================================================================
// The ENGINE half: a real engine over real ports
// ============================================================================

const RUN_ID = 'run-d2' as RunId;
const TOOL: ToolDescriptor = { name: 'read', description: 'read a file', inputSchema: {} };

function manifestFor(): RunManifest {
  return {
    version: 1,
    runId: RUN_ID,
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
    prompt: { role: 'user', id: 'p1', content: 'finish up' },
    history: { kind: 'inline', value: [] },
    attachments: { kind: 'inline', value: [] },
    catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
    steering: [],
    options: {},
  } as RunInputSnapshot;
}

interface EngineRun {
  /** Every fragment the ENGINE handed the host through `ports.context.defer`. */
  readonly deferredFragments: readonly TransientContextFragment[];
  /** Every message the engine actually built for the provider, per turn. */
  readonly sentMessages: readonly (readonly { readonly content: unknown }[])[];
  readonly reasons: readonly string[];
}

/**
 * Drive a real `RunEngineImpl` with a real `before_finalize` contributor whose
 * text is NOT a veto, and report what the host was handed and what the model was
 * sent.
 *
 * `vetoTurns` is deliberately NOT a parameter: whether the contributor vetoes is
 * the contributor's own behaviour (`textAndMaybeVeto`), and keeping the two
 * apart is what stops a test from proving "the text is read on a later turn"
 * with a run that was actually re-opened by the ceiling instead of by a veto.
 */
async function runEngineWith(contributor: ExtensionContributor): Promise<EngineRun> {
  const deferredFragments: TransientContextFragment[] = [];
  const sentMessages: (readonly { readonly content: unknown }[])[] = [];
  const reasons: string[] = [];
  let turn = 0;

  const model: ModelPort = {
    async *stream(request: { readonly messages: readonly { readonly content: unknown }[] }): AsyncIterable<ModelFrame> {
      turn += 1;
      sentMessages.push(request.messages);
      yield { type: 'turn_stopped', reason: 'end_turn' };
    },
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
        for (const item of queued.splice(0, queued.length)) yield item;
      },
      discard(): void {
        queued.length = 0;
      },
      describe: (): readonly ToolDescriptor[] => [TOOL],
    },
    context: {
      assemble: (): Promise<AssembledTurn> =>
        Promise.resolve({
          systemPrompt: 'you are a test',
          messages: [],
          tools: [TOOL],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        }),
      defer(fragment: TransientContextFragment): void {
        deferredFragments.push(fragment);
      },
    },
    approval: {
      authorize: (): Promise<ApprovalVerdict> =>
        Promise.resolve({ allowed: true, scope: 'once' }),
    },
    events: {
      publish(_event: unknown): void {},
      proposeTerminal(): void {},
    },
    extensions: {
      list: (phase) => (phase === 'before_finalize' ? [contributor] : []),
      unload: () => Promise.resolve(),
    } satisfies ExtensionPort,
  };

  const engine = new RunEngineImpl({
    now: () => 1_000,
    defaultMaxTurns: 8,
    onReport: (report) => reasons.push(report.exit.reason),
  });
  const request: RunExecutionRequest = {
    manifest: manifestFor(),
    input: inputFor(),
    signal: new AbortController().signal,
    ports,
  };
  await engine.execute(request).completed();
  return { deferredFragments, sentMessages, reasons };
}

/** A `before_finalize` contributor that returns TEXT, and optionally a veto. */
function textAndMaybeVeto(veto: boolean): ExtensionContributor {
  let seen = 0;
  return {
    id: 'd2:before_finalize',
    phase: 'before_finalize',
    order: 0,
    timeoutMs: 1_000,
    async contribute(_ctx: ExtensionContext): Promise<readonly ExtensionContribution[]> {
      seen += 1;
      const contributions: ExtensionContribution[] = [
        {
          key: `d2:0:${seen}`,
          content: { kind: 'hook_context', key: `d2:0:${seen}`, text: PRE_FINALIZE_TEXT },
          binding: false,
        },
      ];
      if (veto && seen <= 1) {
        contributions.push({
          key: `d2:1:${seen}`,
          content: { veto: true as const, reason: 'keep going' },
          binding: true,
        });
      }
      return contributions;
    },
  };
}

// ============================================================================
// The verdict
// ============================================================================

describe('a non-vetoing before_finalize contribution', () => {
  it('is dropped by the LEGACY bus itself, so the engine is not the odd one out', async () => {
    // THE LEGACY HALF, measured rather than inferred.
    //
    // `LoopHookBus` is the product's own bus and `PreFinalize` declares exactly
    // one honoured effect type. A handler returning an `inject` here is dropped
    // BEFORE `finalizeSuccess` can read the list, which is why the legacy can
    // never deliver this text to the model.
    const effects = await legacyBusOutcome();

    expect(effects).toEqual([]);

    // And the veto half of the disputed claim IS true, which is why this is a
    // parity finding rather than a gap in the engine: the same bus returns the
    // veto when a handler asks for one.
    const { LoopHookBus } = await import('../../hooks/loop.js');
    const bus = new LoopHookBus();
    bus.register({
      id: 'probe.veto',
      events: ['PreFinalize'],
      priority: 10,
      handler: () => ({
        type: 'block_finalize' as const,
        injection: PRE_FINALIZE_TEXT,
        source: 'custom' as const,
      }),
    });
    const vetoed = await bus.dispatch('PreFinalize', {
      sessionId: 's-legacy',
      turnCount: 1,
      seqIndex: 1,
      messages: [],
    });
    expect(vetoed).toHaveLength(1);
    expect(vetoed[0]).toMatchObject({ type: 'block_finalize' });
  });

  it('reaches nobody on the ENGINE path either, which is the parity verdict', async () => {
    // THE ENGINE HALF.
    //
    // The run finalizes on turn 1, so the text the contributor returned is read
    // by nobody. Asserted on the ACTION (`deferredFragments`, what the host was
    // handed) AND on the absence from the one request the model was sent --
    // because "the transcript is empty" alone cannot distinguish a correct
    // implementation from a broken one that discarded the contribution before
    // anyone could see it.
    const run = await runEngineWith(textAndMaybeVeto(false));

    // The run really completed, and on ONE turn: a run that looped would give
    // the text a reader and make this assertion vacuous.
    expect(run.reasons).toEqual(['completed']);
    expect(run.sentMessages).toHaveLength(1);

    // The contribution WAS executed and DID reach the host's rail. This is the
    // engine's own generosity over the legacy, stated rather than hidden: the
    // engine has no per-event effect filter, so it accepts an `inject` the
    // legacy's bus would have dropped.
    expect(run.deferredFragments).toHaveLength(1);
    expect(run.deferredFragments[0].key).toBe('d2:0:1');

    // AND nothing read it. The single request the model received contains no
    // trace of the text, which is the same outcome the legacy produces for the
    // same shape of contribution.
    const everyContent = JSON.stringify(run.sentMessages);
    expect(everyContent).not.toContain(PRE_FINALIZE_TEXT);
  });

  it('IS read when the same contributor vetoes, which is why the engine adopts it at all', async () => {
    // The control, and it is what makes the case above a finding rather than a
    // claim that the engine simply drops `before_finalize` output.
    //
    // A veto re-opens the loop, the next turn's `#modelRequest` reads the
    // deferred rail, and the text the contributor returned rides it. The legacy
    // reaches the model by the same shape -- `applyLoopHookEffect` on the veto
    // -- so the engine's adopt-on-veto is the faithful counterpart, not an
    // improvement.
    const run = await runEngineWith(textAndMaybeVeto(true));

    // Two turns: the veto produced one and the text was read on the second.
    expect(run.sentMessages).toHaveLength(2);
    expect(run.reasons).toEqual(['completed']);

    // The read half: the SECOND request carried the text, the first could not
    // have (the contribution did not exist yet).
    expect(JSON.stringify(run.sentMessages[0])).not.toContain(PRE_FINALIZE_TEXT);
    expect(JSON.stringify(run.sentMessages[1])).toContain(PRE_FINALIZE_TEXT);
  });
});
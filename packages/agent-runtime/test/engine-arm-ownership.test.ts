/**
 * The translator-covered arms the engine does NOT publish, and why.
 *
 * ## Why this file exists
 *
 * The other half of the `tool.call_preview` slice. Of the arms the inbound
 * translator covers but the engine does not produce, exactly one -- the
 * provisional tool announcement -- turned out to be a fact the engine already
 * held (see `tool-call-preview-producer.test.ts`). The rest are NOT the
 * engine's to produce, and this file records each decision so the next slice
 * inherits it instead of re-deriving it.
 *
 * A refusal here is not a gap and not a regression. Each arm below is grouped by
 * WHY the engine cannot own it, and the grouping is the decision:
 *
 *  - **Port-owned projection** -- `subagent.started` / `subagent.completed` /
 *    `hook.invoked`. The engine RECEIVES a raw `AgentProgressEvent` off the
 *    drain, but that frame is the transcript vocabulary, not the protocol's, and
 *    the split between the three destinations needs the un-split payload. The
 *    engine delegates to `projectSubagentProgress` and publishes whatever comes
 *    back; it does not itself decide the destination. A host that binds nothing
 *    gets a counted `diagnostic` per frame, never a fabricated sub-agent event
 *    and never a silence (`run-engine.ts` `#drainOutcomes`, `subagent_progress`
 *    arm). That diagnostic is the guardrail, and it is asserted below.
 *  - **Not a fact the engine holds** -- `tool.progress`, `tool.group_progress`,
 *    `assistant.status`, `turn.retry_scheduled`, `assistant.mode_changed`,
 *    `assistant.goal_updated`. These are worker/host/control-plane narration or
 *    structure. The engine has no progress tick (it receives a final
 *    `durationMs` on the result, never a running one), no tool-group identity
 *    (`ToolCallRequest` has no `groupId`), no status to report, and it
 *    explicitly disclaims retry (`run-engine.ts` model `error` arm: within-
 *    attempt retry is the model port's, cross-run is the Control Plane's). Mode
 *    and goal are host-owned. Publishing any of them from the engine would be
 *    inventing a fact it was never given, which is the rule this plan has
 *    rejected repeatedly.
 *  - **Contract 1e** -- `run.completed` / `run.failed`. The engine computes the
 *    terminal state but `RunSession.settle` is the single writer and
 *    `port-guards.ts` makes a settle-capable engine surface a build failure.
 *    Already pinned in `engine-publication.test.ts`; the reasoning is recorded
 *    in `run-engine.ts` at the `proposeTerminal` site. Not re-tested here.
 *
 * ## What no test here proves
 *
 * No provider key and no Electron renderer exist here, so this does not show a
 * real worker emitting a `status` or `retry` frame, nor a real UI reacting to a
 * missing one. What is shown is that, given a run in which the engine is handed
 * (or could plausibly be handed) the underlying fact, it neither fabricates the
 * arm nor drops the frame silently.
 */

import { describe, expect, it } from 'vitest';
import { RunEngineImpl } from '../src/engine/run-engine.js';
import type {
  ApprovalVerdict,
  AssembledTurn,
  ModelFrame,
  ModelRequest,
  RunEnginePorts,
  RunEventStorePort,
  ToolCallRequest,
  ToolDrainItem,
  TransientContextFragment,
} from '../src/engine/ports.js';
import type { AgentProgressEvent } from '@duya/agent-protocol/transcript';
import type { RunEvent } from '@duya/agent-protocol';

const MANIFEST = {
  runId: 'run-ownership-1',
  workspace: '/tmp',
  tools: [],
  systemPrompt: 'test',
  model: 'test-model',
  providerId: 'test-provider',
  apiFormat: 'anthropic',
} as unknown as Parameters<RunEngineImpl['execute']>[0]['manifest'];

const INPUT = {
  revision: 'rev-1',
  prompt: { role: 'user', id: 'p1', content: 'go' },
  history: { kind: 'inline', value: [] },
  attachments: { kind: 'inline', value: [] },
  catalog: { kind: 'by_ref', digest: 'd1', locator: 'catalog://1' },
  steering: [],
  options: {},
} as unknown as Parameters<RunEngineImpl['execute']>[0]['input'];

const CALL: ToolCallRequest = {
  callId: 'call-1',
  name: 'Read',
  input: { path: 'a.txt' },
  sideEffect: 'read_only',
} as unknown as ToolCallRequest;

const SUBAGENT_EVENT: AgentProgressEvent = {
  type: 'started',
  agentId: 'sub-1',
  agentType: 'explore',
  agentName: 'scout',
};

function subagentItem(): ToolDrainItem {
  return { kind: 'subagent_progress', callId: CALL.callId, event: SUBAGENT_EVENT } as ToolDrainItem;
}

function resultItem(): ToolDrainItem {
  return {
    kind: 'tool_result',
    callId: CALL.callId,
    content: 'done',
    isError: false,
    durationMs: 5,
  } as ToolDrainItem;
}

interface Harness {
  readonly offered: RunEvent[];
  readonly completed: Promise<void>;
  /** Every event the `projectSubagentProgress` port was handed. */
  readonly projected: AgentProgressEvent[];
}

interface Options {
  readonly turnOne?: readonly ModelFrame[];
  readonly batch?: readonly ToolDrainItem[];
  /** Bind the host projection port (the real binding). */
  readonly bindProjection?: boolean;
}

/**
 * Drive one run. Turn 1 dispatches a tool so the drain runs; turn 2 ends clean.
 * `projectSubagentProgress` is bound only when asked, so the UNBOUND host is a
 * real scenario and not a hypothetical.
 */
function harness(options: Options = {}): Harness {
  const offered: RunEvent[] = [];
  const projected: AgentProgressEvent[] = [];

  const events: RunEventStorePort = {
    publish(event: RunEvent): void {
      offered.push(event);
    },
    proposeTerminal(): void {},
    ...(options.bindProjection === true
      ? {
          projectSubagentProgress(event: AgentProgressEvent): RunEvent | null {
            projected.push(event);
            // A host projection, built from the frame the engine actually passed.
            if (event.type !== 'started') return null;
            return {
              type: 'subagent.started',
              subagentId: event.agentId ?? '',
              parentToolCallId: CALL.callId,
              agentType: event.agentType ?? '',
              agentName: event.agentName ?? '',
            };
          },
        }
      : {}),
  };

  let turn = 0;
  const ports: RunEnginePorts = {
    // Required since A3-1. A host with nothing queued SAYS so rather
    // than leaving the port out, which is a compile error -- the
    // engine would otherwise skip the sweep and drop mid-run steering
    // with nothing reporting the loss.
    interTurn: { sweep: () => Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }) },
    model: {
      async *stream(_request: ModelRequest): AsyncIterable<ModelFrame> {
        turn += 1;
        if (turn === 1) {
          yield { type: 'text', text: 'working' };
          if (options.turnOne === undefined) {
            yield { type: 'tool_use', call: CALL };
          } else {
            for (const frame of options.turnOne) yield frame;
          }
        } else {
          yield { type: 'text', text: 'done' };
        }
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    },
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        if (turn === 1) {
          for (const item of options.batch ?? [resultItem()]) yield item;
        }
      },
      discard(): void {},
      describe: () => [],
    },
    context: {
      async assemble(): Promise<AssembledTurn> {
        return {
          systemPrompt: 'test',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        };
      },
      defer(_fragment: TransientContextFragment): void {},
    },
    approval: {
      async authorize(): Promise<ApprovalVerdict> {
        return { allowed: true, scope: 'once' };
      },
    },
    events,
  };

  const engine = new RunEngineImpl({ now: () => 1_000, defaultMaxTurns: 3 });
  const handle = engine.execute({
    manifest: MANIFEST,
    input: INPUT,
    signal: new AbortController().signal,
    ports,
  });
  return { offered, completed: handle.completed(), projected };
}

function types(offered: readonly RunEvent[]): string[] {
  return offered.map((e) => e.type);
}

// ============================================================================
// Port-owned projection: subagent.* and hook.invoked
// ============================================================================

describe('sub-agent progress is the host projection port s, not the engine s', () => {
  it('an UNBOUND port yields a counted diagnostic naming the frame, never a fabricated subagent event', async () => {
    // The guardrail. A sub-agent progress frame with no projection is a
    // failure someone can see; a fabricated `subagent.started` the engine
    // invented would put a sub-agent identity in the durable record that no
    // sub-agent ever reported.
    const h = harness({ batch: [resultItem(), subagentItem()] });
    await h.completed;

    expect(types(h.offered)).not.toContain('subagent.started');
    expect(types(h.offered)).not.toContain('subagent.completed');
    expect(types(h.offered)).not.toContain('hook.invoked');

    const diagnostic = h.offered.find((e) => e.type === 'diagnostic');
    if (diagnostic?.type !== 'diagnostic') throw new Error('expected a diagnostic');
    expect(diagnostic.level).toBe('warn');
    expect(diagnostic.message).toContain('started');
    expect(diagnostic.message).toContain('no protocol destination');
  });

  it('a BOUND port receives the frame and the engine publishes exactly what it returns', async () => {
    // The engine is a conduit for this arm, not its producer: the destination
    // decision belongs to the port, and the engine publishes the port's event
    // verbatim. The projected identity comes from the frame the drain carried.
    const h = harness({ batch: [resultItem(), subagentItem()], bindProjection: true });
    await h.completed;

    // The port saw the real frame, not a synthesized one.
    expect(h.projected).toHaveLength(1);
    expect(h.projected[0]).toEqual(SUBAGENT_EVENT);

    const started = h.offered.find((e) => e.type === 'subagent.started');
    if (started?.type !== 'subagent.started') throw new Error('expected subagent.started');
    expect(started.subagentId).toBe('sub-1');
    expect(started.agentName).toBe('scout');
  });
});

// ============================================================================
// Not a fact the engine holds
// ============================================================================

describe('the engine does not fabricate narration it was never given', () => {
  it('a retryable model error produces NO turn.retry_scheduled', async () => {
    // The engine disclaims retry in the model `error` arm: within-attempt retry
    // is the model port's and cross-run is the Control Plane's, so it neither
    // counts the attempt nor schedules the delay. A `turn.retry_scheduled`
    // here would state an attempt number and a delay nobody decided.
    const h = harness({
      turnOne: [
        { type: 'error', message: 'overloaded', retryable: true },
        { type: 'text', text: 'after' },
      ],
    });
    await h.completed;

    expect(types(h.offered)).not.toContain('turn.retry_scheduled');
  });

  it('a normal dispatched-and-answered run produces no status, goal, mode or progress arms', async () => {
    // One assertion over the whole "not a fact the engine holds" group, because
    // the fact is the same for all of them: the engine has no such state to
    // report. Each is host/worker/control-plane-owned. If any arm appeared here
    // it would be a value the engine fabricated.
    const h = harness({ batch: [resultItem()] });
    await h.completed;

    const published = new Set(types(h.offered));
    for (const arm of [
      'tool.progress',
      'tool.group_progress',
      'assistant.status',
      'assistant.mode_changed',
      'assistant.goal_updated',
      'turn.retry_scheduled',
    ] as const) {
      expect(published.has(arm)).toBe(false);
    }
    // And the arms the engine DOES own for this same run are present, so the
    // negative assertions are not passing merely because nothing ran.
    expect(published.has('tool.call_started')).toBe(true);
    expect(published.has('tool.call_completed')).toBe(true);
  });
});

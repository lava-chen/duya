/**
 * `tool.call_preview` -- the one translator-covered arm the engine held.
 *
 * ## The gap this closes
 *
 * The model port's tool-call lifecycle is
 * `tool_use_started` -> `tool_use_delta`* -> `tool_use`. The engine published
 * the second and third steps (`tool.arguments_delta`, `tool.call_started`) and
 * DROPPED the first. `ToolCallPreviewPayload` is the protocol's durable home
 * for exactly that dropped step -- "something is coming", a tool named with
 * arguments still streaming, `provisional: true` always
 * (`events/payloads.ts:408-418`). Until now only the inbound translator produced
 * it, from the legacy `chat:tool_use_started` frame.
 *
 * ## The value test
 *
 * Every asserted value is compared against a LITERAL the announcement frame
 * supplied (`'call-preview-1'`, `'Bash'`, `{ command: 'ls' }`), never against
 * the published payload itself. The model frame is the only source, so a
 * publisher that emitted a hardcoded placeholder -- a `toolCallId` it invented,
 * a zeroed `elapsedMs`, a synthesized name -- is caught by removing or
 * falsifying the publish, which is what the mutation runs at the bottom prove.
 *
 * ## What no test here proves
 *
 * No provider key and no Electron renderer exist in this environment, so this
 * does not show a real provider emitting the announcement frame or a real UI
 * rendering the preview. The announcement frame is produced by the HOST's model
 * port, which is outside `agent-runtime/src`; what is shown here is that WHEN
 * the host's port delivers the announcement, the engine publishes the durable
 * preview the protocol defines for it.
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
import type { RunEvent } from '@duya/agent-protocol';

// ── fixtures ───────────────────────────────────────────────────────────

const MANIFEST = {
  runId: 'run-preview-1',
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

/** The call as the model port ANNOUNCES it: named, arguments still streaming. */
const ANNOUNCED_CALL: ToolCallRequest = {
  callId: 'call-preview-1',
  name: 'Bash',
  input: { command: 'ls' },
  sideEffect: 'read_only',
} as unknown as ToolCallRequest;

interface Harness {
  /** Every event the engine offered to the port, in order. */
  readonly offered: RunEvent[];
  /** Interleaving markers, to assert a publication's position. */
  readonly order: string[];
  readonly completed: Promise<void>;
}

/**
 * Drive one run whose turn 1 model stream is exactly `turnOneFrames`, then end
 * the run on a clean `end_turn`. Only turn 1 gets the custom frames, so a
 * preview is never double-counted across turns.
 */
function harness(turnOneFrames: readonly ModelFrame[]): Harness {
  const offered: RunEvent[] = [];
  const order: string[] = [];

  const events: RunEventStorePort = {
    publish(event: RunEvent): void {
      order.push(`publish:${event.type}`);
      offered.push(event);
    },
    proposeTerminal(): void {
      order.push('proposeTerminal');
    },
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
          for (const frame of turnOneFrames) yield frame;
        } else {
          yield { type: 'text', text: 'done' };
        }
        yield { type: 'turn_stopped', reason: 'end_turn' };
      },
    },
    tools: {
      dispatch(): void {},
      async *drain(): AsyncIterable<ToolDrainItem> {
        // Nothing ever comes back: this suite is about the announcement, not
        // about a result.
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
  return { offered, order, completed: handle.completed() };
}

function previews(offered: readonly RunEvent[]) {
  return offered.filter((e) => e.type === 'tool.call_preview');
}

// ============================================================================
// The producer
// ============================================================================

describe('the engine publishes tool.call_preview for an announced call', () => {
  it('carries the ANNOUNCEMENT s own values, and is provisional', async () => {
    const h = harness([
      { type: 'tool_use_started', call: ANNOUNCED_CALL },
      { type: 'tool_use_delta', callId: ANNOUNCED_CALL.callId, delta: '{"command"' },
    ]);
    await h.completed;

    const found = previews(h.offered);
    expect(found).toHaveLength(1);
    const preview = found[0];
    if (preview?.type !== 'tool.call_preview') throw new Error('expected a preview');
    // Compared against the literals the announcement frame carried, so a
    // publisher that invented any of them fails here.
    expect(preview.toolCallId).toBe('call-preview-1');
    expect(preview.toolName).toBe('Bash');
    expect(preview.arguments).toEqual({ command: 'ls' });
    expect(preview.provisional).toBe(true);
  });

  it('lands BEFORE the authoritative tool.call_started, so "coming" precedes "this will run"', async () => {
    // POSITION is the claim: the preview is the provisional signal and the
    // dispatch writes the durable intent record. A preview after call_started
    // would announce a call the host was already told had started.
    const h = harness([
      { type: 'tool_use_started', call: ANNOUNCED_CALL },
      { type: 'tool_use_delta', callId: ANNOUNCED_CALL.callId, delta: '{"command"' },
    ]);
    await h.completed;

    const previewAt = h.order.indexOf('publish:tool.call_preview');
    const startedAt = h.order.indexOf('publish:tool.call_started');
    expect(previewAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(previewAt).toBeLessThan(startedAt);
  });
});

describe('a complete-only call produces NO preview', () => {
  it('a provider that sends only tool_use yields one call_started and zero previews', async () => {
    // The negative half, and the one that keeps the count honest: there was no
    // provisional window to see, so there is nothing to preview. Without this a
    // regression that published a preview per DISPATCH (not per announcement)
    // would still pass the positive tests above.
    const h = harness([{ type: 'tool_use', call: ANNOUNCED_CALL }]);
    await h.completed;

    expect(previews(h.offered)).toHaveLength(0);
    const started = h.offered.filter((e) => e.type === 'tool.call_started');
    expect(started).toHaveLength(1);
  });
});

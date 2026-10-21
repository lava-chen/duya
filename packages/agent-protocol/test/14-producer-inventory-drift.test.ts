/**
 * Producer inventory — a DRIFT TEST, not a conformance test.
 *
 * The name matters. This file reads a source file as text and compares
 * declarations. It never runs the worker and never moves a byte, so calling
 * anything here "conformance" would claim evidence it does not have. The
 * conformance suite is `worker-adapter-conformance.test.ts`, which drives real
 * fixtures through the real adapter; the lifecycle suite is
 * `lifecycle-invariants.test.ts`, which drives real event sequences.
 *
 * ## What this file may and may not assert
 *
 * This test used to assert two things that were not yet decided:
 *
 *  - that `tool.call_started` is `durable`;
 *  - that the worker's optional `error` flag becomes the protocol's required
 *    `isError`, with absence defaulted to `false`.
 *
 * Both were answers smuggled in as tests. The gap register said the semantics
 * were open, the register was right, and a passing test would have made the
 * opposite look settled — a reader checking whether a question was open would
 * find a green check and stop looking. **A test that answers an open question
 * is worse than no test**, because it is indistinguishable from a test that
 * checks a settled one.
 *
 * Both are now decided (G-6, G-7) and both are enforced in
 * `lifecycle-invariants.test.ts`. What is left here is only what is true
 * regardless of those decisions: the target can express everything the source
 * declares, and anything it deliberately does not carry names the decision that
 * governs it.
 *
 * ## Why the source is read as text
 *
 * Importing the worker types would add a `packages/agent` dependency to the
 * protocol package's test surface, which the boundary gate treats as a
 * violation, and inside a worktree a bare specifier resolves through the
 * node_modules junction to the PRIMARY checkout instead of this tree.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { extractInterface } from './extract-worker-fields.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKER = join(REPO_ROOT, 'packages', 'agent', 'src', 'process', 'worker-protocol.ts');
const PROTOCOL_PAYLOADS = fileURLToPath(new URL('../src/events/payloads.ts', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

if (!existsSync(WORKER)) {
  throw new Error(`cannot verify against the real event source: ${WORKER} is missing`);
}
const worker = readFileSync(WORKER, 'utf8');
const payloads = readFileSync(PROTOCOL_PAYLOADS, 'utf8');

function protocolFields(iface: string): string[] {
  const fields = extractInterface(payloads, iface);
  if (!fields) throw new Error(`protocol payload not found: ${iface}`);
  return fields.map((f) => f.name);
}

const ENVELOPE_LEVEL = new Set(['type', 'sessionId', 'id']);
const rootSegment = (p: string): string => p.split('.')[0]!;

interface Pair {
  readonly worker: string;
  readonly protocol: string;
  /** Fields the protocol renames. The map is the point: a normalisation that
   *  is not written down is a normalisation nobody reviews. */
  readonly renames?: Readonly<Record<string, string>>;
  /**
   * Fields the protocol does NOT carry, and the decision that governs what
   * they become.
   *
   * This is the escape hatch that replaced the old `error -> isError` rename.
   * That rename asserted a mapping — optional boolean to required boolean,
   * absence to `false` — which is a semantic decision, not a rename, and it
   * was being made by a test. Now the field is declared as classified, and the
   * named file has to exist and be the one that actually decides.
   */
  readonly classified?: Readonly<Record<string, string>>;
}

const PAIRS: readonly Pair[] = [
  { worker: 'GoalUpdatedEvent', protocol: 'AssistantGoalUpdatedPayload' },
  { worker: 'AgentModeChangedEvent', protocol: 'AssistantModeChangedPayload' },
  { worker: 'AgentStatusEvent', protocol: 'AssistantStatusPayload' },
  { worker: 'AgentTextEvent', protocol: 'AssistantTextBlockPayload', renames: { content: 'text' } },
  {
    worker: 'AgentThinkingEvent',
    protocol: 'AssistantThinkingBlockPayload',
    renames: { content: 'thinking' },
  },
  {
    // The authoritative, durable half. `chat:tool_use` is what DuyaAgent.ts
    // names as the re-emission that carries the final arguments.
    worker: 'SubagentToolUseEvent',
    protocol: 'ToolCallStartedPayload',
    renames: { name: 'toolName', input: 'arguments' },
  },
  {
    // The provisional half, now volatile. Both worker interfaces are identical
    // apart from the discriminant, and mapping both onto one payload was the
    // bug that made a durable event fire twice per call.
    worker: 'SubagentToolUseStartedEvent',
    protocol: 'ToolCallPreviewPayload',
    renames: { name: 'toolName', input: 'arguments' },
  },
  {
    worker: 'SubagentToolProgressEvent',
    protocol: 'ToolProgressPayload',
    renames: { toolUseId: 'toolCallId' },
  },
  {
    worker: 'SubagentToolResultEvent',
    protocol: 'ToolCallCompletedPayload',
    renames: { result: 'content', duration_ms: 'durationMs' },
    classified: {
      error:
        'lifecycle-invariants.test.ts — the optional boolean becomes a ToolCallOutcome; an absent bit is `indeterminate`, never `success`',
    },
  },
  {
    worker: 'AgentRetryEvent',
    protocol: 'TurnRetryScheduledPayload',
    renames: { message: 'reason' },
  },
  {
    worker: 'AgentErrorEvent',
    protocol: 'RunFailedPayload',
    // The worker sends `code?: string`. `ProtocolErrorInfo` requires a closed
    // `ErrorCode`, so the adapter classifies: protocol code from the boundary
    // taxonomy, producer string preserved in `cause`. See G-1.
    classified: {
      code:
        'lifecycle-invariants.test.ts — free string becomes a closed ErrorCode plus a preserved ErrorCause',
    },
    renames: { message: 'error' },
  },
  {
    // The wire extension that makes `assistant.message_finalized` producible at
    // all. Before this frame the only terminal frame was `chat:done` =
    // `{ sessionId }`, which carries neither of the two REQUIRED fields, so no
    // host could emit the event without inventing them.
    //
    // No `renames` and no `classified`: every field here reaches the payload
    // under its own name. That is deliberate and worth stating, because the
    // ADAPTER still narrows two of them — the transcript content union into the
    // payload's four-member one, and the runtime's nine stop reasons into the
    // payload's six. Those narrowings are decisions about this package's own
    // two vocabularies, so they are recorded where the vocabularies are:
    // `23-wire-field-classification.test.ts` ("the event payload vocabulary is
    // NARROWER than the transcript one, by design"). What the adapter does
    // with them — preserving a block it cannot type under
    // `providerMeta.untranslatedBlocks`, refusing a reason it cannot state — is
    // asserted in the runtime's `translator-projector.test.ts`.
    worker: 'AgentMessageFinalizedEvent',
    protocol: 'AssistantMessageFinalizedPayload',
  },
];

/**
 * Every worker event with no protocol counterpart, and why.
 *
 * An entry is a RECORDED DECISION, not an approval. The assertion below fails
 * if the worker grows an event in neither list, so "nobody looked at this"
 * cannot be mistaken for "this is fine".
 *
 * The four product-facing ones are deliberately NOT agent-protocol events. Each
 * names the domain that owns it; see G-4 in the gap register.
 */
const UNMAPPED: ReadonlyArray<readonly [string, string]> = [
  ['ChatStartCommand', 'host -> worker input, not an event; becomes run.start + turn.started'],
  ['InitCommand', 'host -> worker input; its providerConfig.apiKey is exactly what the manifest must not carry'],
  ['ChatInterruptCommand', 'host -> worker input; becomes run.cancel over the control channel'],
  [
    'AgentPermissionEvent',
    'DECIDED (G-2): the runtime owns classification and the clock. An adapter must not derive kind/mode from toolName; until a coordinator exists the runtime withholds the event rather than inventing expiresAt.',
  ],
  [
    'AgentDoneEvent',
    'DECIDED (G-5): a stateful aggregator may build run.completed, but only from observed sources. A field with no source stays absent rather than filled.',
  ],
  ['AgentAgentProgressEvent', 'split across subagent.* and hook.invoked; all 11 fields now carried'],
  [
    'ResearchUpdatedEvent',
    'DECIDED (G-4): NOT an agent-protocol event. Research is a domain projection; the router already splits it into three SSE events and a host projection owns the rest.',
  ],
  [
    'AgentTitleGeneratedEvent',
    'DECIDED (G-4): NOT an agent-protocol event. A session title is a host/view concern; the agent run does not produce it.',
  ],
  [
    'WorkflowRunEvent',
    'DECIDED (G-4): NOT an agent-protocol event. Workflow runs belong to the Control Plane, which has its own protocol.',
  ],
  [
    'AgentDbPersistedEvent',
    'DECIDED (G-4): success is not an agent event. A persist failure that affects run correctness maps to the `persistence_failed` ErrorCode on run.failed.',
  ],
  ['AgentDebugEvent', 'folded into diagnostic'],
  [
    'CheckpointEvent',
    'DECIDED (G-3): the legacy payload is the transcript, so it does not cross the boundary. checkpoint.saved carries a reference and an eventSeq instead.',
  ],
  ['SubagentToolUseDeltaEvent', 'maps to tool.arguments_delta'],
  ['ClipboardWriteEvent', 'a UI command, not agent state; the worker has no clipboard'],
];

describe('producer inventory: nothing is silently dropped', () => {
  it('the extraction found the interfaces it claims to', () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true, which is the worst possible failure for a no-loss test.
    for (const { worker: iface } of PAIRS) {
      const fields = extractInterface(worker, iface);
      expect(fields, `${iface} not found in worker-protocol.ts`).not.toBeNull();
      expect(fields!.length, `${iface} extracted zero fields`).toBeGreaterThan(1);
    }
  });

  it.each(PAIRS)('$worker reaches $protocol', (pair) => {
    const { worker: workerIface, protocol, renames = {}, classified = {} } = pair;
    const source = extractInterface(worker, workerIface)!;
    const target = new Set(protocolFields(protocol));

    const dropped = source
      .map((f) => f.name)
      .filter((n) => !ENVELOPE_LEVEL.has(n))
      .map((n) => renames[n] ?? n)
      .filter((n) => !(n in classified))
      .filter((n) => !target.has(rootSegment(n)));

    expect(
      dropped,
      `${workerIface} declares fields that ${protocol} cannot express, under any name. ` +
        `Either carry them, add a rename, or list them under \`classified\` naming the decision that governs them.`,
    ).toEqual([]);
  });

  it('every rename points at a field that actually exists', () => {
    // Otherwise a typo silently "maps" a dropped field to a payload that does
    // not have it, and the assertion above goes green on a rename that would
    // not compile in the adapter.
    for (const { worker: w, protocol, renames = {} } of PAIRS) {
      const target = new Set(protocolFields(protocol));
      for (const [from, to] of Object.entries(renames)) {
        expect(target.has(rootSegment(to)), `${w}.${from} -> ${protocol}.${to}, whose first segment does not exist`).toBe(true);
      }
    }
  });

  it('every rename source actually exists in the worker event', () => {
    for (const { worker: w, renames = {}, classified = {} } of PAIRS) {
      const source = new Set(extractInterface(worker, w)!.map((f) => f.name));
      for (const from of Object.keys({ ...renames, ...classified })) {
        expect(source.has(from), `${w} has no field ${from}, so the mapping is dead`).toBe(true);
      }
    }
  });

  it('every classified field names a test file that exists', () => {
    // The whole point of `classified` is that it is not a free-form excuse. A
    // decision that governs a field has to point at the file that enforces it,
    // and that file has to be real — otherwise "decided elsewhere" becomes the
    // default answer for anything nobody wants to decide.
    for (const { worker: w, classified = {} } of PAIRS) {
      for (const [field, decision] of Object.entries(classified)) {
        const file = decision.split(/[\s—(]/)[0]!;
        expect(
          existsSync(join(TEST_DIR, file)),
          `${w}.${field} is classified by "${decision}" but ${file} does not exist in the test directory`,
        ).toBe(true);
        expect(decision.trim().length, `${w}.${field} is classified with no explanation`).toBeGreaterThan(20);
      }
    }
  });

  it('every worker event is either mapped or explicitly recorded', () => {
    // The assertion that makes UNMAPPED a decision log rather than a comment.
    const accounted = new Set([...PAIRS.map((p) => p.worker), ...UNMAPPED.map(([w]) => w)]);
    const declared = [...worker.matchAll(/export interface (\w+)\s*\{/g)].map((m) => m[1]!);
    const actual = declared.filter((name) => {
      const body = worker.slice(worker.indexOf('export interface ' + name + ' {'));
      const discriminant = /type:\s*'(chat:[^']+)'|type:\s*'(checkpoint)'/.exec(body.slice(0, 400));
      return discriminant !== null && !/\n {2,}export interface/.test(body.slice(0, 60));
    });
    expect(
      actual.filter((name) => !accounted.has(name)),
      'these worker events are neither mapped nor recorded — add one or the other',
    ).toEqual([]);
  });

  it('every recorded entry says why, and still exists in the worker', () => {
    for (const [name, reason] of UNMAPPED) {
      expect(reason.trim().length, `${name} is recorded with no reason`).toBeGreaterThan(20);
      expect(extractInterface(worker, name), `${name} is recorded but no longer exists`).not.toBeNull();
    }
  });

  it('the two tool announcements map to DIFFERENT payloads', () => {
    // Structural counterpart to the durability decision. If both worker
    // interfaces land on one payload again, the durable event fires twice per
    // call with the same id and different arguments.
    const byWorker = new Map(PAIRS.map((p) => [p.worker, p.protocol]));
    expect(byWorker.get('SubagentToolUseStartedEvent')).toBe('ToolCallPreviewPayload');
    expect(byWorker.get('SubagentToolUseEvent')).toBe('ToolCallStartedPayload');
    expect(byWorker.get('SubagentToolUseStartedEvent')).not.toBe(byWorker.get('SubagentToolUseEvent'));
  });
});

describe("the mode vocabulary is the runtime's, not an invention", () => {
  it('every mode the worker can emit is a legal AssistantMode, and vice versa', () => {
    const modeLine = new RegExp(
      `export\\s+interface\\s+AgentModeChangedEvent\\s*\\{[\\s\\S]*?mode:\\s*([^;]+);`,
    ).exec(worker);
    expect(modeLine, 'could not read the worker mode union').not.toBeNull();
    const workerModes = [...(modeLine![1].matchAll(/'([^']+)'/g))].map((m) => m[1]!).sort();

    const declared = new RegExp(
      `export\\s+const\\s+ASSISTANT_MODES\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as const`,
    ).exec(payloads);
    expect(declared, 'ASSISTANT_MODES is not declared as a const array').not.toBeNull();
    const protocolModes = [...(declared![1].matchAll(/'([^']+)'/g))].map((m) => m[1]!).sort();

    // Both directions. A mode the runtime emits that the protocol cannot
    // express is a lost capability; a mode the protocol allows that the
    // runtime never emits is a fiction a future implementer will code against.
    expect(
      { missingFromProtocol: workerModes.filter((m) => !protocolModes.includes(m)) },
      'the worker can emit a mode the protocol cannot carry',
    ).toEqual({ missingFromProtocol: [] });
    expect(
      { notEmittedByRuntime: protocolModes.filter((m) => !workerModes.includes(m)) },
      'the protocol allows a mode the runtime never emits',
    ).toEqual({ notEmittedByRuntime: [] });
  });
});

describe('tool correlation uses exactly one id name', () => {
  it('no protocol tool payload says toolUseId', () => {
    // The legacy wire mixes `id`, `toolCallId` and `toolUseId`. The protocol
    // picks one, because a result that cannot be joined to its invocation is a
    // silently orphaned row in every tool timeline.
    const offenders = payloads
      .split(/\r?\n/)
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s{2}(?:readonly\s+)?\w*[tT]oolUseId\??:/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(offenders, 'a payload still uses toolUseId instead of toolCallId').toEqual([]);
  });

  it('the preview, started and completed payloads join on the same field', () => {
    for (const iface of ['ToolCallPreviewPayload', 'ToolCallStartedPayload', 'ToolCallCompletedPayload']) {
      expect(protocolFields(iface), `${iface} has no toolCallId`).toContain('toolCallId');
    }
  });
});

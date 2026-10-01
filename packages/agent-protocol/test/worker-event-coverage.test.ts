/**
 * The protocol must be able to carry everything the worker actually emits.
 *
 * ## Why this test exists when drift test #9 already exists
 *
 * #9 checks the protocol's legacy table against `packages/ai/src/types.ts`,
 * the SSE union. That turned out to be the wrong fact source, and not by a
 * small margin:
 *
 *  - The SSE union types `mode` as a bare `string`. A protocol that tightens
 *    `string` into a closed union has to choose a vocabulary, and choosing from
 *    a field that carries no information means inventing one. That is exactly
 *    how `AssistantMode` became `default | plan | research | conductor | goal`
 *    — a third vocabulary matching neither the runtime nor anything else.
 *  - The SSE union does not carry the goal payload's fields at all, so a
 *    projection that dropped `pauseMessage`, `elapsedMs` and six others looked
 *    complete against it while losing data the UI reads.
 *
 * `packages/agent/src/process/worker-protocol.ts` is the fact source. It is
 * what the runtime actually prints. This test reads it and asserts that every
 * field it declares survives into the corresponding protocol payload.
 *
 * ## Why the source is read as text
 *
 * Importing the worker types would add a `packages/agent` dependency to the
 * protocol package's test surface, which the boundary gate treats as a
 * violation, and inside a worktree a bare specifier resolves through the
 * node_modules junction to the PRIMARY checkout instead of this tree. Same
 * reasoning as drift test #9.
 *
 * ## Why this is not the adapter test
 *
 * The adapter that maps these events does not exist until PP-2. This asserts
 * the narrower and more durable property: the TARGET cannot express less than
 * the SOURCE. A payload that drops a field fails here whether or not an
 * adapter happens to be written to fill it in later.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { extractInterface } from './extract-worker-fields.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WORKER = join(REPO_ROOT, 'packages', 'agent', 'src', 'process', 'worker-protocol.ts');
const PROTOCOL_PAYLOADS = fileURLToPath(new URL('../src/events/payloads.ts', import.meta.url));

if (!existsSync(WORKER)) {
  throw new Error(`cannot verify against the real event source: ${WORKER} is missing`);
}
const worker = readFileSync(WORKER, 'utf8');
const payloads = readFileSync(PROTOCOL_PAYLOADS, 'utf8');

/** Fields a protocol payload declares, by interface name. */
function protocolFields(iface: string): string[] {
  const fields = extractInterface(payloads, iface);
  if (!fields) throw new Error(`protocol payload not found: ${iface}`);
  return fields.map((f) => f.name);
}

/** `sessionId` and `type` are envelope-level in the protocol, not payload. */
const ENVELOPE_LEVEL = new Set(['type', 'sessionId', 'id']);

/**
 * Each row: the worker's event interface, the protocol payload that must carry
 * it, and the RENAMES the adapter is expected to perform.
 *
 * The rename map is the point. A field that keeps its name needs no entry; a
 * field the protocol deliberately normalises declares where it goes, so the
 * normalisation is reviewable instead of invisible. A NEW field in
 * worker-protocol.ts appears in no row and fails the assertion below — which is
 * the whole reason this table exists.
 *
 * `chat:text` and `chat:thinking` are paired with the BLOCK payloads, not the
 * delta payloads. The worker emits one complete `content` per event; the
 * per-token deltas in the SSE union are synthesised by the router from the
 * model stream, not by worker-protocol, so there is no worker field to lose.
 */
const PAIRS: ReadonlyArray<{
  readonly worker: string;
  readonly protocol: string;
  readonly renames?: Readonly<Record<string, string>>;
}> = [
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
    worker: 'SubagentToolUseEvent',
    protocol: 'ToolCallStartedPayload',
    renames: { name: 'toolName', input: 'arguments' },
  },
  {
    worker: 'SubagentToolUseStartedEvent',
    protocol: 'ToolCallStartedPayload',
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
    // `error` is not a boolean here, it is an optional flag whose absence
    // meant success — which is why 1666 stored results have no error marker.
    // The protocol makes it a mandatory `isError`, so the adapter has to
    // default absence to `false` rather than pass `undefined` through.
    renames: { result: 'content', error: 'isError', duration_ms: 'durationMs' },
  },
];

describe('worker event source: nothing is silently dropped', () => {
  it('the extraction found the interfaces it claims to', () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true, which is the worst possible failure for a no-loss test.
    for (const { worker: iface } of PAIRS) {
      const fields = extractInterface(worker, iface);
      expect(fields, `${iface} not found in worker-protocol.ts`).not.toBeNull();
      expect(fields!.length, `${iface} extracted zero fields`).toBeGreaterThan(1);
    }
  });

  it.each(PAIRS)('$worker reaches $protocol', ({ worker: workerIface, protocol, renames = {} }) => {
    const source = extractInterface(worker, workerIface)!;
    const target = new Set(protocolFields(protocol));

    const dropped = source
      .map((f) => f.name)
      .filter((n) => !ENVELOPE_LEVEL.has(n))
      .map((n) => renames[n] ?? n)
      .filter((n) => !target.has(n));

    expect(
      dropped,
      `${workerIface} declares fields that ${protocol} cannot express, under any name. ` +
        `Either carry them, or add the rename to the table in this file so the decision is reviewable.`,
    ).toEqual([]);
  });

  it('every rename in the table points at a field that actually exists', () => {
    // Otherwise a typo in the table silently "maps" a dropped field to a
    // payload that does not have it, and the assertion above goes green on a
    // rename that would not compile in the adapter.
    for (const { worker: w, protocol, renames = {} } of PAIRS) {
      const target = new Set(protocolFields(protocol));
      for (const [from, to] of Object.entries(renames)) {
        expect(
          target.has(to),
          `${w}.${from} is renamed to ${protocol}.${to}, which does not exist`,
        ).toBe(true);
      }
    }
  });

  it('every rename source actually exists in the worker event', () => {
    for (const { worker: w, renames = {} } of PAIRS) {
      const source = new Set(extractInterface(worker, w)!.map((f) => f.name));
      for (const from of Object.keys(renames)) {
        expect(source.has(from), `${w} has no field ${from}, so the rename is dead`).toBe(true);
      }
    }
  });
});

describe('the mode vocabulary is the runtime\'s, not an invention', () => {
  it('every mode the worker can emit is a legal AssistantMode', () => {
    const iface = extractInterface(worker, 'AgentModeChangedEvent')!;
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

    expect(iface.map((f) => f.name)).toContain('mode');
  });
});

describe('tool correlation uses exactly one id name', () => {
  it('no protocol tool payload says toolUseId', () => {
    // The legacy wire mixes `id`, `toolCallId` and `toolUseId`. The protocol
    // has to pick one, because a result that cannot be joined to its
    // invocation is a silently orphaned row in every tool timeline.
    //
    // The `readonly` modifier is part of the pattern for the same reason it is
    // in the extractor: a pattern that does not allow it matches the bare
    // spelling and misses the one every payload actually uses, which is the
    // worst kind of test — it looks like coverage and is not.
    const offenders = payloads
      .split(/\r?\n/)
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /^\s{2}(?:readonly\s+)?\w*[tT]oolUseId\??:/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(offenders, 'a payload still uses toolUseId instead of toolCallId').toEqual([]);
  });

  it('the started and completed payloads join on the same field', () => {
    const started = protocolFields('ToolCallStartedPayload');
    const completed = protocolFields('ToolCallCompletedPayload');
    expect(started).toContain('toolCallId');
    expect(completed).toContain('toolCallId');
  });
});

describe('a tool invocation is a durable fact', () => {
  it('tool.call_started is durable so a crash leaves a trace of the intent', () => {
    // If the intent is volatile, a process death mid-tool leaves no record that
    // the call was ever attempted, and a side-effect ledger has nothing to
    // reconcile against. The completed event alone cannot substitute: a tool
    // that never returned is precisely the case that needs recording.
    const registry = readFileSync(
      fileURLToPath(new URL('../src/events/registry.ts', import.meta.url)),
      'utf8',
    );
    const line = new RegExp(`'tool\\.call_started':\\s*\\{[^}]*durability:\\s*'(\\w+)'`).exec(registry);
    expect(line, 'could not read tool.call_started durability').not.toBeNull();
    expect(line![1]).toBe('durable');
  });
});

describe('run failure carries a closed error, not a free string', () => {
  it('RunFailedPayload does not reopen the taxonomy with a bare code string', () => {
    const body = payloads.slice(payloads.indexOf('export interface RunFailedPayload'));
    const block = body.slice(0, body.indexOf('}'));
    expect(block, 'could not read RunFailedPayload').toContain('ProtocolErrorInfo');
    expect(
      /readonly\s+code\s*:\s*string/.test(block),
      'RunFailedPayload declares a free-form code, which bypasses ErrorCode',
    ).toBe(false);
  });

  it('RunTerminalState is a discriminated union, not a bag of optionals', () => {
    const run = readFileSync(fileURLToPath(new URL('../src/run.ts', import.meta.url)), 'utf8');
    const block = run.slice(run.indexOf('export type RunTerminalState'));
    const arms = (block.slice(0, block.indexOf('\n\n')).match(/readonly status: '/g) || []).length;
    expect(arms, 'RunTerminalState no longer has one arm per status').toBe(4);
    expect(
      /readonly error\?:/.test(block.slice(0, block.indexOf('\n\n'))),
      'error is optional, so a run can fail with no error',
    ).toBe(false);
  });
});

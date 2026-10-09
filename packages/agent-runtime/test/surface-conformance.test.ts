/**
 * Conformance suite for the surface model. NO RENDERER IS PRESENT.
 *
 * ## What this file is for
 *
 * The blessed TUI is one consumer of `SurfaceModel`; React will be the second.
 * The thing that stops them drifting is that both are held to THIS spec, which
 * runs against the model alone. If a second renderer arrives and it disagrees
 * with blessed about what `run.paused` means, one of them fails here first.
 *
 * ## How it fails
 *
 * Every case asserts a CONCRETE value — a phase, a status, a field — against a
 * literal. Nothing here asserts only that a call did not throw. This repo has a
 * recorded scar of a guard suite whose assertions ran against string literals
 * rewritten to `''`, so 19 tests asserted nothing while staying green; a
 * conformance suite that cannot go red is worse than no conformance suite.
 *
 * ## Coverage is a compile error, not a review item
 *
 * `CONFORMANCE_CASES` is typed `Record<EventType, ConformanceCase>`, so a 39th
 * protocol event without a case is a build failure. The runtime count
 * assertion in the first test reconciles the table against `EVENT_TYPES` from
 * the registry — not against a copy of it.
 *
 * ## Payloads are the protocol's own
 *
 * Envelopes are built around `EVENT_FIXTURES`, which `agent-protocol` holds to
 * its required-field manifest. Using them means every payload here is legal by
 * construction, so a failure is always about the surface model and never about
 * a hand-typed fixture that forgot a required field.
 */

import { describe, expect, it } from 'vitest';
import type { EventType, RunEvent, RunEventEnvelope } from '@duya/agent-protocol';
import { EVENT_TYPES, eventSpecOf } from '@duya/agent-protocol';
import { EVENT_FIXTURES } from '@duya/agent-protocol/testing';
import {
  LEGACY_MAPPED_EVENT_TYPES,
  LEGACY_UNMAPPED_EVENT_TYPES,
  isLegacyMapped,
  SurfaceModel,
  replayOntoSurface,
} from '@duya/agent-runtime';
import { projectToLegacyFrame } from '../src/project/legacy-sse-projector.js';

const RUN_ID = 'run-conformance';
const SESSION_ID = 'session-conformance';
const BASE_TS = 1_700_000_000_000;

/** A legal envelope around the protocol's own minimal fixture payload. */
function envelope<T extends EventType>(
  type: T,
  overrides: { readonly seq?: number; readonly timestamp?: number; readonly payload?: object } = {},
): RunEventEnvelope<RunEvent & { type: T }> {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    seq: overrides.seq ?? 1,
    timestamp: overrides.timestamp ?? BASE_TS,
    traceId: 'trace-conformance',
    payload: { type, ...((EVENT_FIXTURES[type] ?? {}) as object), ...(overrides.payload ?? {}) },
  } as RunEventEnvelope<RunEvent & { type: T }>;
}

/** A fresh run's preamble: `run.started` plus one `turn.started`. */
function startedModel(): SurfaceModel {
  const model = new SurfaceModel();
  model.apply(envelope('run.started', { seq: 1 }));
  model.apply(envelope('turn.started', { seq: 2 }));
  return model;
}

// ── the case table ────────────────────────────────────────────────────────

interface ConformanceCase {
  /** Events applied before this one, so the case can start mid-lifecycle. */
  readonly prelude?: readonly EventType[];
  readonly payload?: object;
  readonly effect: string;
  /** Concrete assertions against the resulting surface. */
  readonly expect: (model: SurfaceModel) => void;
}

/**
 * One entry per protocol event. Keyed by `EventType`, so a new event without a
 * case fails the build rather than silently losing coverage.
 */
const CONFORMANCE_CASES: Record<EventType, ConformanceCase> = {
  // ── run ─────────────────────────────────────────────────────────────────
  'run.started': {
    effect: 'run',
    expect: (m) => {
      expect(m.runState.status).toBe('running');
      expect(m.runState.runId).toBe(RUN_ID);
      expect(m.runState.sessionId).toBe(SESSION_ID);
      expect(m.runState.manifestHash).toBe('a'.repeat(64));
      expect(m.runState.protocolVersion).toBe('1.0');
      expect(m.runState.runtimeName).toBe('test-runtime');
      expect(m.runState.resumedFrom).toBeNull();
    },
  },
  'run.paused': {
    prelude: ['run.started'],
    payload: { at: 'tool_boundary' },
    effect: 'run',
    expect: (m) => {
      expect(m.runState.status).toBe('paused');
      expect(m.runState.pausedAt).toBe('tool_boundary');
    },
  },
  'run.completed': {
    prelude: ['run.started', 'turn.started'],
    effect: 'run',
    expect: (m) => {
      expect(m.runState.status).toBe('completed');
      expect(m.runState.stopReason).toBe('end_turn');
      // No `turn.completed` arrived, so the run's ending must retire the open
      // turn rather than leave it claiming to be live.
      expect(m.currentTurn).toBeNull();
      expect(m.turns[0]?.phase).toBe('completed');
    },
  },
  'run.failed': {
    prelude: ['run.started', 'turn.started'],
    effect: 'run_failed',
    expect: (m) => {
      expect(m.runState.status).toBe('failed');
      expect(m.runState.error?.code).toBe('internal');
      expect(m.runState.error?.message).toBe('fixture');
      // The whole point: a turn that never completed is distinguishable from
      // one that never began.
      expect(m.turns[0]?.phase).toBe('failed');
      expect(m.currentTurn).toBeNull();
    },
  },

  // ── turn ────────────────────────────────────────────────────────────────
  'turn.started': {
    effect: 'turn',
    expect: (m) => {
      expect(m.turns).toHaveLength(1);
      expect(m.turns[0]?.phase).toBe('running');
      expect(m.turns[0]?.turnId).toBe('turn-1');
      expect(m.turns[0]?.index).toBe(0);
      expect(m.turns[0]?.model).toBe('test-model');
      expect(m.turns[0]?.providerId).toBe('test-provider');
      expect(m.turns[0]?.apiFormat).toBe('anthropic');
      expect(m.currentTurn?.turnId).toBe('turn-1');
    },
  },
  'turn.retry_scheduled': {
    prelude: ['turn.started'],
    effect: 'turn',
    expect: (m) => {
      expect(m.turns[0]?.phase).toBe('retrying');
      expect(m.turns[0]?.retry?.attempt).toBe(1);
      expect(m.turns[0]?.retry?.maxAttempts).toBe(3);
      expect(m.turns[0]?.retry?.delayMs).toBe(500);
      expect(m.turns[0]?.retry?.reason).toBe('fixture');
      expect(m.currentTurn?.turnId).toBe('turn-1');
    },
  },
  'turn.completed': {
    prelude: ['turn.started'],
    effect: 'turn',
    expect: (m) => {
      expect(m.turns[0]?.phase).toBe('completed');
      expect(m.turns[0]?.stopReason).toBe('end_turn');
      expect(m.turns[0]?.durationMs).toBe(10);
      expect(m.turns[0]?.usage?.totalTokens).toBe(2);
      expect(m.usageState?.totalTokens).toBe(2);
      expect(m.currentTurn).toBeNull();
    },
  },

  // ── assistant ───────────────────────────────────────────────────────────
  'assistant.text_block': {
    effect: 'message',
    expect: (m) => {
      expect(m.messages[0]?.messageId).toBe('msg-1');
      expect(m.messages[0]?.text).toBe('hello');
      expect(m.messages[0]?.finalized).toBe(false);
    },
  },
  'assistant.text_delta': {
    effect: 'message',
    payload: { messageId: 'msg-1', index: 0, delta: 'he' },
    expect: (m) => {
      expect(m.messages[0]?.text).toBe('he');
      expect(m.messages[0]?.finalized).toBe(false);
    },
  },
  'assistant.thinking_block': {
    effect: 'message',
    expect: (m) => {
      expect(m.messages[0]?.thinking).toBe('thinking');
    },
  },
  'assistant.thinking_delta': {
    effect: 'message',
    payload: { messageId: 'msg-1', index: 0, delta: 'th' },
    expect: (m) => {
      expect(m.messages[0]?.thinking).toBe('th');
    },
  },
  'assistant.message_finalized': {
    prelude: ['assistant.text_delta'],
    effect: 'message',
    expect: (m) => {
      expect(m.messages[0]?.finalized).toBe(true);
      expect(m.messages[0]?.stopReason).toBe('end_turn');
      // The engine republishes the whole block after streaming deltas, so the
      // finalized text REPLACES the streamed one. A renderer that appended both
      // would print every answer twice — assert the exact value, not just that
      // it changed.
      expect(m.messages[0]?.text).toBe('hello');
    },
  },
  'assistant.usage': {
    effect: 'usage',
    expect: (m) => {
      expect(m.usageState?.inputTokens).toBe(1);
      expect(m.usageState?.outputTokens).toBe(1);
      expect(m.usageState?.totalTokens).toBe(2);
    },
  },
  'assistant.mode_changed': {
    effect: 'mode',
    expect: (m) => {
      expect(m.modeState).toBe('plan');
      expect(m.modeSourceState).toBe('user');
    },
  },
  'assistant.goal_updated': {
    effect: 'goal',
    // Every optional field the producer sends must survive, because the UI reads
    // `pauseMessage` and `totalWorkerRounds` and neither is reconstructible.
    payload: { totalWorkerRounds: 3, pauseMessage: 'waiting on review', planFile: '/plan.md' },
    expect: (m) => {
      expect(m.goalState?.state).toBe('active');
      expect(m.goalState?.objective).toBe('fixture');
      expect(m.goalState?.totalWorkerRounds).toBe(3);
      expect(m.goalState?.pauseMessage).toBe('waiting on review');
      expect(m.goalState?.planFile).toBe('/plan.md');
    },
  },
  'assistant.status': {
    effect: 'status',
    expect: (m) => {
      expect(m.statusState).toBe('working');
    },
  },

  // ── tool ────────────────────────────────────────────────────────────────
  'tool.call_preview': {
    effect: 'tool',
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('preview');
      expect(tool?.name).toBe('Read');
      // Provisional, and kept apart from the authoritative arguments.
      expect(tool?.provisionalArguments).toEqual({});
      expect(tool?.arguments).toBeNull();
      expect(tool?.settled).toBe(false);
    },
  },
  'tool.arguments_delta': {
    prelude: ['tool.call_preview'],
    effect: 'tool',
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('streaming_arguments');
      expect(tool?.argumentText).toBe('{}');
      // Streaming fragments must NOT overwrite the provisional object.
      expect(tool?.provisionalArguments).toEqual({});
      expect(tool?.arguments).toBeNull();
    },
  },
  'tool.call_started': {
    prelude: ['tool.call_preview'],
    effect: 'tool',
    payload: { arguments: { path: 'final.txt' } },
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('started');
      // Final arguments are a DIFFERENT field from the provisional ones, so a
      // renderer can show "what might run" and "what will run" separately.
      expect(tool?.arguments).toEqual({ path: 'final.txt' });
      expect(tool?.provisionalArguments).toEqual({});
      expect(tool?.attempt).toBe(1);
      expect(tool?.settled).toBe(false);
    },
  },
  'tool.progress': {
    prelude: ['tool.call_started'],
    effect: 'tool',
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('progress');
      expect(tool?.progress?.elapsedMs).toBe(5);
      // Absent optional fields become explicit nulls rather than `undefined`, so
      // a renderer never has to distinguish "missing" from "not yet".
      expect(tool?.progress?.title).toBeNull();
      expect(tool?.progress?.percent).toBeNull();
      expect(tool?.settled).toBe(false);
    },
  },
  'tool.group_progress': {
    effect: 'tool_group',
    expect: (m) => {
      // The unnamed group (groupId is optional on the payload) is retained
      // rather than dropped, so a renderer can still show "N tools running".
      expect(m.toolGroupSurfaces).toHaveLength(1);
      expect(m.toolGroupSurfaces[0]).toMatchObject({
        groupId: null,
        title: 'fixture group',
        source: 'test',
      });
    },
  },
  'tool.timed_out': {
    prelude: ['tool.call_started'],
    effect: 'tool',
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('timed_out');
      expect(tool?.name).toBe('Read');
      // NOT settled: the durable `tool.call_completed` may still arrive and
      // must not be hidden by marking the row finished here.
      expect(tool?.settled).toBe(false);
    },
  },
  'tool.call_completed': {
    prelude: ['tool.call_started'],
    effect: 'tool',
    expect: (m) => {
      const tool = m.toolByCallId('call-1');
      expect(tool?.phase).toBe('completed');
      expect(tool?.result).toBe('ok');
      expect(tool?.settled).toBe(true);
      expect(tool?.outcome).toEqual({ outcome: 'success' });
      expect(tool?.durationMs).toBe(1);
    },
  },

  // ── checkpoint ──────────────────────────────────────────────────────────
  'checkpoint.saved': {
    prelude: ['run.started'],
    effect: 'checkpoint',
    expect: (m) => {
      expect(m.latestCheckpointState?.checkpointRef).toBe('ckpt-1');
      expect(m.latestCheckpointState?.generation).toBe(1);
      expect(m.latestCheckpointState?.eventSeq).toBe(4);
      expect(m.latestCheckpointState?.runId).toBe(RUN_ID);
      expect(m.checkpointLog).toHaveLength(1);
    },
  },

  // ── permission ──────────────────────────────────────────────────────────
  'permission.requested': {
    effect: 'permission',
    expect: (m) => {
      const p = m.permissionById('req-1');
      expect(p?.phase).toBe('requested');
      expect(p?.toolName).toBe('Bash');
      // `kind` and the authoritative clock have no legacy counterpart at all.
      expect(p?.kind).toBe('tool_use');
      expect(p?.startedAt).toBe(0);
      expect(p?.expiresAt).toBe(300_000);
      expect(p?.awaitingAnswer).toBe(true);
      expect(m.openPermissions).toHaveLength(1);
    },
  },
  'permission.resolved': {
    prelude: ['permission.requested'],
    effect: 'permission',
    expect: (m) => {
      const p = m.permissionById('req-1');
      expect(p?.phase).toBe('resolved');
      expect(p?.resolution?.action).toBe('allow');
      expect(p?.resolution?.source).toBe('host');
      expect(p?.awaitingAnswer).toBe(false);
      // A plain allow never expired.
      expect(p?.expiredAfterMs).toBeNull();
      expect(m.openPermissions).toHaveLength(0);
    },
  },
  'permission.expired': {
    prelude: ['permission.requested'],
    effect: 'permission',
    expect: (m) => {
      const p = m.permissionById('req-1');
      expect(p?.phase).toBe('expired');
      expect(p?.expiredAfterMs).toBe(300_000);
      // An expired request is no longer awaiting an answer even though no
      // resolution has arrived yet.
      expect(p?.awaitingAnswer).toBe(false);
    },
  },

  // ── compaction ──────────────────────────────────────────────────────────
  'compaction.started': {
    effect: 'compaction',
    expect: (m) => {
      expect(m.compactions[0]?.phase).toBe('running');
      expect(m.compactions[0]?.trigger).toBe('auto');
    },
  },
  'compaction.step': {
    prelude: ['compaction.started'],
    effect: 'compaction',
    expect: (m) => {
      expect(m.compactions[0]?.phase).toBe('running');
      expect(m.compactions[0]?.lastStep).toBe('summarize');
    },
  },
  'compaction.completed': {
    prelude: ['compaction.started'],
    effect: 'compaction',
    expect: (m) => {
      expect(m.compactions[0]?.phase).toBe('completed');
      expect(m.compactions[0]?.boundaryId).toBe('boundary-1');
      // The fixture sends no strategy, so the surface says null rather than
      // leaving a field that reads as set.
      expect(m.compactions[0]?.strategy).toBeNull();
    },
  },
  'compaction.failed': {
    prelude: ['compaction.started'],
    effect: 'compaction',
    expect: (m) => {
      expect(m.compactions[0]?.phase).toBe('failed');
      expect(m.compactions[0]?.error).toBe('fixture');
    },
  },
  'compaction.over_threshold': {
    effect: 'over_threshold',
    expect: (m) => {
      expect(m.lastThresholdWarning).toEqual({
        tokensRetained: 200_000,
        available: 150_000,
      });
    },
  },

  // ── subagent / hook ─────────────────────────────────────────────────────
  'subagent.started': {
    effect: 'subagent',
    expect: (m) => {
      const s = m.subagentById('sub-1');
      expect(s?.phase).toBe('started');
      expect(s?.agentName).toBe('fixture');
      expect(s?.agentType).toBe('general');
      expect(s?.parentToolCallId).toBe('call-1');
      expect(s?.status).toBeNull();
    },
  },
  'subagent.completed': {
    prelude: ['subagent.started'],
    effect: 'subagent',
    expect: (m) => {
      const s = m.subagentById('sub-1');
      expect(s?.phase).toBe('completed');
      expect(s?.status).toBe('completed');
      expect(s?.durationMs).toBe(100);
      // The identity fields survive, because the completion carries none.
      expect(s?.agentName).toBe('fixture');
      expect(s?.parentToolCallId).toBe('call-1');
    },
  },
  'hook.invoked': {
    effect: 'hook',
    expect: (m) => {
      expect(m.hooksState).toHaveLength(1);
      expect(m.hooksState[0]?.hookName).toBe('fixture-hook');
      expect(m.hooksState[0]?.hookType).toBe('command');
      expect(m.hooksState[0]?.async).toBe(false);
      expect(m.hooksState[0]?.status).toBe('ok');
      expect(m.hooksState[0]?.durationMs).toBe(3);
      expect(m.hooksState[0]?.errorMessage).toBeNull();
    },
  },

  // ── diagnostic / extension ──────────────────────────────────────────────
  diagnostic: {
    effect: 'diagnostic',
    expect: (m) => {
      expect(m.diagnosticsState).toHaveLength(1);
      expect(m.diagnosticsState[0]?.level).toBe('info');
      expect(m.diagnosticsState[0]?.message).toBe('fixture diagnostic');
    },
  },
  'diagnostic.trace': {
    effect: 'trace',
    expect: (m) => {
      // A NEGATIVE assertion, and a real one: it fails the moment the model
      // starts retaining spans. `diagnostic.trace` is ephemeral, and a long run
      // that kept them would grow with its trace volume.
      expect(m.retainedTraces).toHaveLength(0);
    },
  },
  'extension.custom': {
    effect: 'extension',
    expect: (m) => {
      expect(m.extensionsState).toHaveLength(1);
      expect(m.extensionsState[0]?.namespace).toBe('test.fixture');
      expect(m.extensionsState[0]?.name).toBe('ping');
    },
  },
};

// ── 1. the vocabulary reconciliation ──────────────────────────────────────

describe('surface conformance: vocabulary', () => {
  it('covers every protocol event exactly once', () => {
    const caseTypes = Object.keys(CONFORMANCE_CASES) as EventType[];
    const registryTypes = [...EVENT_TYPES];

    // The count is asserted, not assumed: if someone adds a protocol event the
    // compiler forces a case, and these two agree. If someone DELETES one, this
    // is the assertion that notices.
    expect(registryTypes).toHaveLength(38);
    expect(caseTypes).toHaveLength(registryTypes.length);

    const missing = registryTypes.filter((t) => !caseTypes.includes(t));
    const extra = caseTypes.filter((t) => !registryTypes.includes(t));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });

    // No duplicate case can hide a gap.
    expect(new Set(caseTypes).size).toBe(caseTypes.length);
  });

  it('reconciles the durable/volatile/ephemeral split against the registry', () => {
    // `EVENT_TYPES` is `keyof RunEventPayloads`, derived in registry.ts. Reading
    // it from the registry rather than re-listing the keys is what makes this a
    // reconciliation and not a second copy.
    const durable = EVENT_TYPES.filter((t) => eventSpecOf(t)?.durability === 'durable');
    const volatile = EVENT_TYPES.filter((t) => eventSpecOf(t)?.durability === 'volatile');
    const ephemeral = EVENT_TYPES.filter((t) => eventSpecOf(t)?.durability === 'ephemeral');

    expect(durable.length + volatile.length + ephemeral.length).toBe(38);
    // The split is what the legacy view never had and what makes replay and
    // reconnect expressible; assert it is non-trivial rather than all-durable.
    expect(durable.length).toBeGreaterThan(0);
    expect(volatile.length).toBeGreaterThan(0);
    expect(ephemeral.length).toBeGreaterThan(0);
  });
});

// ── 2. per-event conformance ──────────────────────────────────────────────

describe('surface conformance: every protocol event', () => {
  for (const type of EVENT_TYPES) {
    it(`${type} produces its declared surface state`, () => {
      const testCase = CONFORMANCE_CASES[type];
      const model = new SurfaceModel();

      let seq = 0;
      for (const prior of testCase.prelude ?? []) {
        seq += 1;
        model.apply(envelope(prior, { seq }));
      }
      seq += 1;
      const effect = model.apply(
        envelope(type, { seq, timestamp: BASE_TS + seq, payload: testCase.payload }),
      );

      expect(effect.kind).toBe(testCase.effect);
      testCase.expect(model);
    });
  }
});

// ── 3. effects for the cases whose payload lives in the effect ────────────

describe('surface conformance: effect payloads', () => {
  it('reports a tool group with its title and source', () => {
    const model = new SurfaceModel();
    expect(model.apply(envelope('tool.group_progress'))).toMatchObject({
      kind: 'tool_group',
      group: { title: 'fixture group', source: 'test' },
    });
  });

  it('reports an over-threshold compaction signal with both numbers', () => {
    const model = new SurfaceModel();
    expect(model.apply(envelope('compaction.over_threshold'))).toMatchObject({
      kind: 'over_threshold',
      tokensRetained: 200_000,
      available: 150_000,
    });
  });

  it('reports a trace span without retaining it on the surface', () => {
    const model = new SurfaceModel();
    const effect = model.apply(envelope('diagnostic.trace'));
    expect(effect).toMatchObject({ kind: 'trace', traceId: 'trace-1', name: 'fixture-span' });
  });

  it('reports no effect for a retry with no turn in flight', () => {
    // Attributing it to "the last turn, any phase" would be a guess.
    const model = new SurfaceModel();
    expect(model.apply(envelope('turn.retry_scheduled')).kind).toBe('none');
  });
});

// ── 4. the capabilities the legacy surface could not express ─────────────

describe('surface conformance: turn lifecycle', () => {
  it('walks started -> retrying -> completed on one turn', () => {
    const model = startedModel();
    expect(model.currentTurn?.turnId).toBe('turn-1');

    model.apply(envelope('turn.retry_scheduled', { seq: 3 }));
    expect(model.turnById('turn-1')?.phase).toBe('retrying');

    model.apply(envelope('turn.completed', { seq: 4 }));
    expect(model.turnById('turn-1')?.phase).toBe('completed');
    expect(model.currentTurn).toBeNull();
  });

  it('keeps one turn per turn id and orders them by arrival', () => {
    const model = new SurfaceModel();
    model.apply(envelope('turn.started', { seq: 1, payload: { turnId: 'turn-a', index: 0 } }));
    model.apply(envelope('turn.started', { seq: 2, payload: { turnId: 'turn-b', index: 1 } }));

    expect(model.turns.map((t) => t.turnId)).toEqual(['turn-a', 'turn-b']);
    expect(model.turnById('turn-a')?.index).toBe(0);
    expect(model.turnById('turn-b')?.index).toBe(1);
    expect(model.turnById('turn-missing')).toBeNull();
  });

  it('records a turn that completed without ever announcing itself', () => {
    const model = new SurfaceModel();
    model.apply(envelope('turn.completed', { seq: 1, payload: { turnId: 'turn-orphan' } }));
    // Dropping it would make an unannounced completion indistinguishable from a
    // dropped event.
    expect(model.turnById('turn-orphan')?.phase).toBe('completed');
  });

  it('retires every open turn when the run fails', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1 }));
    model.apply(envelope('turn.started', { seq: 2, payload: { turnId: 'turn-a', index: 0 } }));
    model.apply(envelope('turn.completed', { seq: 3, payload: { turnId: 'turn-a', index: 0 } }));
    model.apply(envelope('turn.started', { seq: 4, payload: { turnId: 'turn-b', index: 1 } }));

    const effect = model.apply(envelope('run.failed', { seq: 5 }));

    expect(effect.kind).toBe('run_failed');
    // The completed turn is left alone; only the open one is retired.
    expect(model.turnById('turn-a')?.phase).toBe('completed');
    expect(model.turnById('turn-b')?.phase).toBe('failed');
    if (effect.kind === 'run_failed') {
      expect(effect.turns.map((t) => t.turnId)).toEqual(['turn-b']);
    }
  });
});

describe('surface conformance: paused is not stalled', () => {
  it('reports a paused run as paused however long the silence lasts', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1, timestamp: 1_000 }));
    model.apply(envelope('run.paused', { seq: 2, timestamp: 1_000 }));

    // An hour of silence while paused. A model that inferred "stalled" from
    // silence alone would report a healthy waiting-on-host run as broken.
    const view = model.describeRun(1_000 + 3_600_000, 30_000);
    expect(view.stalled).toBe(false);
    expect(view.status).toBe('paused');
    expect(view.silentMs).toBe(3_600_000);
  });

  it('reports a running run as stalled only after the silence threshold', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1, timestamp: 1_000 }));

    expect(model.describeRun(1_000 + 5_000, 30_000).stalled).toBe(false);
    expect(model.describeRun(1_000 + 30_000, 30_000).stalled).toBe(true);
    expect(model.describeRun(1_000 + 31_000, 30_000).status).toBe('running');
  });

  it('never reports a terminal run as stalled', () => {
    const completed = new SurfaceModel();
    completed.apply(envelope('run.started', { seq: 1, timestamp: 1_000 }));
    completed.apply(envelope('run.completed', { seq: 2, timestamp: 1_100 }));
    expect(completed.describeRun(1_000 + 3_600_000, 30_000).stalled).toBe(false);

    const failed = new SurfaceModel();
    failed.apply(envelope('run.started', { seq: 1, timestamp: 1_000 }));
    failed.apply(envelope('run.failed', { seq: 2, timestamp: 1_100 }));
    expect(failed.describeRun(1_000 + 3_600_000, 30_000).stalled).toBe(false);
  });

  it('advances the silence clock with every envelope, not only run events', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1, timestamp: 1_000 }));
    expect(model.describeRun(100_000, 30_000).stalled).toBe(true);

    // A delta proves the run is alive. Without this the firehose of ephemeral
    // events would still read as a hang.
    model.apply(envelope('assistant.text_delta', { seq: 2, timestamp: 100_000 }));
    expect(model.describeRun(100_000, 30_000).stalled).toBe(false);
    expect(model.runState.lastProgressAt).toBe(100_000);
  });
});

describe('surface conformance: tool call phases', () => {
  it('walks the full preview -> arguments -> started -> progress -> completed arc', () => {
    const model = new SurfaceModel();
    const seen: string[] = [];
    const record = (): void => {
      const phase = model.toolByCallId('call-1')?.phase;
      if (phase !== undefined) seen.push(phase);
    };

    model.apply(envelope('tool.call_preview', { seq: 1 }));
    record();
    model.apply(envelope('tool.arguments_delta', { seq: 2 }));
    record();
    model.apply(envelope('tool.call_started', { seq: 3 }));
    record();
    model.apply(envelope('tool.progress', { seq: 4 }));
    record();
    model.apply(envelope('tool.call_completed', { seq: 5 }));
    record();

    expect(seen).toEqual(['preview', 'streaming_arguments', 'started', 'progress', 'completed']);
  });

  it('keeps one tool object across its whole lifecycle', () => {
    const model = new SurfaceModel();
    model.apply(envelope('tool.call_preview', { seq: 1 }));
    const first = model.toolByCallId('call-1');
    model.apply(envelope('tool.call_completed', { seq: 2 }));
    // Identity, not equality: a renderer addresses the row it needs.
    expect(model.toolByCallId('call-1')).toBe(first);
    expect(model.toolCallCount).toBe(1);
  });

  it('counts a phase revision per change so a renderer can skip equal rows', () => {
    const model = new SurfaceModel();
    model.apply(envelope('tool.call_preview', { seq: 1 }));
    expect(model.toolByCallId('call-1')?.phaseRevision).toBe(1);

    model.apply(envelope('tool.call_started', { seq: 2 }));
    expect(model.toolByCallId('call-1')?.phaseRevision).toBe(2);

    model.apply(envelope('tool.progress', { seq: 3 }));
    expect(model.toolByCallId('call-1')?.phaseRevision).toBe(3);
  });

  it('does not reopen a settled call when a late progress tick arrives', () => {
    const model = new SurfaceModel();
    model.apply(envelope('tool.call_started', { seq: 1 }));
    model.apply(envelope('tool.call_completed', { seq: 2 }));
    expect(model.toolByCallId('call-1')?.phase).toBe('completed');

    model.apply(envelope('tool.progress', { seq: 3 }));
    // The tick is recorded, but it is not evidence the call is live again.
    expect(model.toolByCallId('call-1')?.phase).toBe('completed');
    expect(model.toolByCallId('call-1')?.settled).toBe(true);
    expect(model.toolByCallId('call-1')?.progress?.elapsedMs).toBe(5);
  });

  it('keeps a timeout and its durable completion as separate facts', () => {
    const model = new SurfaceModel();
    model.apply(envelope('tool.call_started', { seq: 1 }));
    model.apply(envelope('tool.timed_out', { seq: 2 }));
    expect(model.toolByCallId('call-1')?.phase).toBe('timed_out');
    expect(model.toolByCallId('call-1')?.settled).toBe(false);

    model.apply(
      envelope('tool.call_completed', {
        seq: 3,
        payload: { outcome: { outcome: 'timeout', afterMs: 30_000 }, durationMs: 30_000 },
      }),
    );
    const tool = model.toolByCallId('call-1');
    expect(tool?.phase).toBe('completed');
    expect(tool?.settled).toBe(true);
    expect(tool?.outcome).toEqual({ outcome: 'timeout', afterMs: 30_000 });
  });

  it('preserves an indeterminate outcome rather than reporting success', () => {
    const model = new SurfaceModel();
    model.apply(
      envelope('tool.call_completed', {
        seq: 1,
        payload: { outcome: { outcome: 'indeterminate', note: 'producer sent no status' } },
      }),
    );
    // The legacy `error?: boolean` cannot say this, which is part of why the
    // surface is keyed on the protocol rather than the frame.
    expect(model.toolByCallId('call-1')?.outcome).toEqual({
      outcome: 'indeterminate',
      note: 'producer sent no status',
    });
  });

  it('records a completion for a call that never announced itself', () => {
    const model = new SurfaceModel();
    model.apply(
      envelope('tool.call_completed', { seq: 1, payload: { toolCallId: 'call-orphan' } }),
    );
    expect(model.toolByCallId('call-orphan')?.phase).toBe('completed');
    expect(model.toolCallCount).toBe(1);
  });
});

describe('surface conformance: permission lifecycle', () => {
  it('distinguishes a timeout from a human denial', () => {
    const model = new SurfaceModel();
    model.apply(envelope('permission.requested', { seq: 1 }));
    model.apply(envelope('permission.expired', { seq: 2 }));
    model.apply(
      envelope('permission.resolved', {
        seq: 3,
        payload: { action: 'deny', source: 'timeout', latencyMs: 300_000 },
      }),
    );

    const p = model.permissionById('req-1');
    // Both events land and the end state is `resolved` — which is exactly why
    // `expiredAfterMs` has to survive the resolution.
    expect(p?.phase).toBe('resolved');
    expect(p?.resolution?.source).toBe('timeout');
    expect(p?.expiredAfterMs).toBe(300_000);
  });

  it('leaves a plain denial with no expiry record', () => {
    const model = new SurfaceModel();
    model.apply(envelope('permission.requested', { seq: 1 }));
    model.apply(
      envelope('permission.resolved', {
        seq: 2,
        payload: { action: 'deny', source: 'user', latencyMs: 900 },
      }),
    );
    const p = model.permissionById('req-1');
    expect(p?.phase).toBe('resolved');
    expect(p?.expiredAfterMs).toBeNull();
  });

  it('reports a resolution for a request that was never raised', () => {
    const model = new SurfaceModel();
    model.apply(
      envelope('permission.resolved', {
        seq: 1,
        payload: { requestId: 'req-orphan', action: 'allow', source: 'policy', latencyMs: 0 },
      }),
    );
    expect(model.permissionById('req-orphan')?.resolution?.action).toBe('allow');
    expect(model.permissionById('req-orphan')?.phase).toBe('resolved');
  });

  it('drops the request from the open set as soon as it expires', () => {
    const model = new SurfaceModel();
    model.apply(envelope('permission.requested', { seq: 1 }));
    expect(model.openPermissions).toHaveLength(1);

    model.apply(envelope('permission.expired', { seq: 2 }));
    // A host must stop prompting for a request whose deadline has passed.
    expect(model.openPermissions).toHaveLength(0);
  });
});

describe('surface conformance: checkpoints and subagents', () => {
  it('keeps the newest checkpoint addressable and the whole log', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1 }));
    model.apply(envelope('checkpoint.saved', { seq: 2 }));
    model.apply(
      envelope('checkpoint.saved', { seq: 3, payload: { generation: 2, checkpointRef: 'ckpt-2' } }),
    );

    expect(model.latestCheckpointState?.generation).toBe(2);
    expect(model.latestCheckpointState?.checkpointRef).toBe('ckpt-2');
    expect(model.checkpointLog.map((c) => c.generation)).toEqual([1, 2]);
  });

  it('stamps a checkpoint with the run it belongs to', () => {
    const model = new SurfaceModel();
    model.apply(envelope('run.started', { seq: 1 }));
    model.apply(envelope('checkpoint.saved', { seq: 2 }));
    // `seq` is unique per RUN, not per session, so the ref is meaningless
    // without the run it was minted in.
    expect(model.latestCheckpointState?.runId).toBe(RUN_ID);
    expect(model.latestCheckpointState?.eventSeq).toBe(4);
  });
});

// ── 5. the legacy path stays total ────────────────────────────────────────

describe('surface conformance: legacy projection stays total', () => {
  it('splits the registry into mapped and unmapped with no gap or overlap', () => {
    expect(LEGACY_UNMAPPED_EVENT_TYPES).toHaveLength(11);
    expect(LEGACY_MAPPED_EVENT_TYPES).toHaveLength(27);
    expect(LEGACY_MAPPED_EVENT_TYPES.length + LEGACY_UNMAPPED_EVENT_TYPES.length).toBe(
      EVENT_TYPES.length,
    );

    const overlap = LEGACY_MAPPED_EVENT_TYPES.filter((t) =>
      LEGACY_UNMAPPED_EVENT_TYPES.includes(t),
    );
    expect(overlap).toEqual([]);
  });

  it('keeps every terminal and every blocking request on the legacy path', () => {
    // The protocol marks `run.`, `permission.` and `checkpoint.` CRITICAL: an
    // unread terminal must not quietly become a success, and an unread
    // `permission.requested` is a blocked tool with nobody answering. Of the
    // critical events, exactly the ones the legacy surface can express must
    // still reach it — the three below are the ones it has a frame for.
    //
    // This replaces an earlier cross-check against the protocol's own
    // `NEW_PROTOCOL_EVENTS` list. That constant lives in
    // `agent-protocol/legacy/`, a DIRECTORY subpath the boundary resolver
    // cannot follow (it has no `index.ts`), and `agent-runtime` is
    // `managed: true`, so the edge is both unresolvable and un-declarable.
    // Dropping a genuinely redundant assertion beat adding an unverifiable one.
    const criticalMapped = EVENT_TYPES.filter(
      (t) => eventSpecOf(t)?.critical === true && isLegacyMapped(t),
    );
    expect([...criticalMapped].sort()).toEqual([
      'permission.requested',
      'run.completed',
      'run.failed',
    ]);

    // And each of those three still produces a frame, not just a set membership.
    for (const type of criticalMapped) {
      expect(projectToLegacyFrame(envelope(type))).not.toBeNull();
    }
  });

  it('still produces a frame for every event that had one before', () => {
    // The totality claim, event by event, against the registry itself rather
    // than a transcribed list. If an arm is deleted from the projector, this
    // goes red on exactly that event.
    const missing: EventType[] = [];
    const wronglyDropped: EventType[] = [];

    for (const type of EVENT_TYPES) {
      const frame = projectToLegacyFrame(envelope(type));
      const shouldMap = isLegacyMapped(type);
      if (shouldMap && frame === null) missing.push(type);
      if (!shouldMap && frame !== null) wronglyDropped.push(type);
    }

    expect({ missing, wronglyDropped }).toEqual({ missing: [], wronglyDropped: [] });
    expect(missing).toHaveLength(0);
  });

  it('emits one frame per mapped event through a single replay', () => {
    const mapped = EVENT_TYPES.filter((t) => isLegacyMapped(t));
    const envelopes = mapped.map((type, i) => envelope(type, { seq: i + 1 }));
    const { model, legacyFrames } = replayOntoSurface(envelopes);

    expect(legacyFrames).toHaveLength(27);
    // Every frame's `type` is in the legacy vocabulary the renderer already
    // parses, and none is empty.
    for (const frame of legacyFrames) {
      expect(frame.type).not.toBe('');
    }
    // The surface saw the same stream.
    expect(model.runState.status).not.toBe('pending');
    expect(model.toolCallCount).toBeGreaterThan(0);
  });

  it('drives both consumers from one pass without letting them disagree', () => {
    const envelopes = [
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      envelope('assistant.text_delta', { seq: 3 }),
      envelope('tool.call_started', { seq: 4 }),
      envelope('tool.call_completed', { seq: 5 }),
      envelope('turn.completed', { seq: 6 }),
      envelope('run.completed', { seq: 7 }),
    ];

    const { model, legacyFrames, effects } = replayOntoSurface(envelopes);

    // The legacy path produced exactly what it produced before.
    expect(legacyFrames.map((f) => f.type)).toEqual([
      'turn_start',
      'text_delta',
      'tool_use',
      'tool_result',
      'done',
    ]);
    // And the surface path additionally knows things the frames never said.
    expect(model.runState.status).toBe('completed');
    expect(model.turns[0]?.phase).toBe('completed');
    expect(effects.filter((e) => e.kind !== 'none').length).toBe(envelopes.length);
  });

  it('surfaces a turn terminal event the legacy projection drops entirely', () => {
    // `turn.completed` reaches `null`. This is the clearest single reason the
    // surface model cannot be built on the frame vocabulary.
    expect(projectToLegacyFrame(envelope('turn.completed'))).toBeNull();

    const { model, legacyFrames } = replayOntoSurface([
      envelope('run.started', { seq: 1 }),
      envelope('turn.started', { seq: 2 }),
      envelope('turn.completed', { seq: 3 }),
    ]);
    expect(legacyFrames.map((f) => f.type)).toEqual(['turn_start']);
    expect(model.turns[0]?.phase).toBe('completed');
    expect(model.turns[0]?.durationMs).toBe(10);
  });
});

// ── 6. the model carries no clock of its own ──────────────────────────────

describe('surface conformance: determinism', () => {
  it('gives the same state for the same stream twice', () => {
    const build = (): SurfaceModel => {
      const model = new SurfaceModel();
      for (const [i, type] of EVENT_TYPES.entries()) {
        model.apply(envelope(type, { seq: i + 1, timestamp: BASE_TS + i }));
      }
      return model;
    };
    const a = build();
    const b = build();
    expect(JSON.stringify(a.runState)).toBe(JSON.stringify(b.runState));
    expect(a.turns.map((t) => t.phase)).toEqual(b.turns.map((t) => t.phase));
    expect(a.toolCallCount).toBe(b.toolCallCount);
  });

  it('clears every region on reset', () => {
    const model = new SurfaceModel();
    for (const [i, type] of EVENT_TYPES.entries()) {
      model.apply(envelope(type, { seq: i + 1, timestamp: BASE_TS + i }));
    }
    expect(model.toolCallCount).toBeGreaterThan(0);

    model.reset();

    expect(model.runState.status).toBe('pending');
    expect(model.runState.lastProgressAt).toBe(0);
    expect(model.turns).toHaveLength(0);
    expect(model.toolCalls).toHaveLength(0);
    expect(model.permissions).toHaveLength(0);
    expect(model.subagents).toHaveLength(0);
    expect(model.messages).toHaveLength(0);
    expect(model.compactions).toHaveLength(0);
    expect(model.checkpointLog).toHaveLength(0);
    expect(model.latestCheckpointState).toBeNull();
    expect(model.hooksState).toHaveLength(0);
    expect(model.diagnosticsState).toHaveLength(0);
    expect(model.extensionsState).toHaveLength(0);
    expect(model.usageState).toBeNull();
    expect(model.modeState).toBeNull();
    expect(model.goalState).toBeNull();
    expect(model.statusState).toBeNull();
  });
});

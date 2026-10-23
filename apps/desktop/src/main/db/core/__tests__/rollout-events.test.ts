/**
 * The rollout taxonomy has ONE authority (plan 620 Phase A6).
 *
 * Adding a rollout event type used to mean editing seven places in
 * lockstep. Only one of them failed loudly — the storage layer's
 * `EventKind` — and the others failed silently: an unknown `type` fell
 * through `deriveKind` to `payload.message.role`, threw a TypeError
 * inside the write transaction, and left an orphan line in the rollout
 * file with no index row. `hook_invoked` lived in exactly that state.
 *
 * This file covers the authority and the consumers that can be reached
 * from here. The two that cannot — the HTTP validator and the storage
 * layer's `deriveKind` — are covered by source-level assertions and by
 * the storage tests respectively, and both are noted inline.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ROLLOUT_EVENT_TYPES,
  WORKER_EMITTABLE_EVENT_TYPES,
  isRolloutEvent,
  isRolloutEventType,
  type HookInvokedEvent,
  type PromptSnapshotEvent,
  type ReasoningEvent,
  type RebaseEvent,
  type RolloutEvent,
  type RotationEvent,
  type SystemContextEvent,
  type ToolCallEvent,
  type TurnStartedEvent,
} from '../rollout-events';
import type { MessageEntry } from '@duya/agent-core/message';
import {
  MIRROR_COVERS_THE_AUTHORITY,
  MIRROR_TYPES_ARE_KNOWN,
  type WorkerRolloutEventType,
} from '@duya/host/worker-journal/types';

describe('rollout event taxonomy — one authority', () => {
  it('lists every discriminator the union declares', () => {
    // The union is written out by hand (each member has a shape); the
    // authority table is derived. This assertion is what keeps them from
    // drifting: add a type to the table and the union must catch up.
    const unionTypes: RolloutEvent['type'][] = [
      sampleReasoning().type,
      sampleToolCall().type,
      sampleTurnStarted().type,
      sampleSystemContext().type,
      sampleHookInvoked().type,
      sampleRebase().type,
      sampleRotation().type,
      samplePromptSnapshot().type,
    ];
    expect([...ROLLOUT_EVENT_TYPES].sort()).toEqual([...unionTypes].sort());
  });

  it('recognises every declared type, and nothing else', () => {
    for (const type of ROLLOUT_EVENT_TYPES) {
      expect(isRolloutEventType(type)).toBe(true);
    }
    expect(isRolloutEventType('unknown')).toBe(false);
    expect(isRolloutEvent({ type: 'unknown' })).toBe(false);
    expect(isRolloutEvent({ type: 'message' })).toBe(false);
    expect(isRolloutEvent(null)).toBe(false);
    expect(isRolloutEvent('reasoning')).toBe(false);
  });

  it('narrows a payload of every declared type', () => {
    for (const sample of allSamples()) {
      expect(isRolloutEvent(sample)).toBe(true);
      expect(typeof sample.id).toBe('string');
      expect(sample.id.length).toBeGreaterThan(0);
    }
  });

  it('keeps the discriminator unique across the union', () => {
    const types = allSamples().map((event) => event.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('covers every worker-emittable type in the journal mirror', () => {
    // The mirror is the worker's half of the taxonomy. It must cover
    // everything the authority says a worker can emit, and it must not
    // carry a type the authority does not know — that shape is what made
    // `hook_invoked` un-derivable.
    expect(MIRROR_COVERS_THE_AUTHORITY).toBe(true);
    expect(MIRROR_TYPES_ARE_KNOWN).toBe(true);
    for (const type of WORKER_EMITTABLE_EVENT_TYPES) {
      expect(
        type as WorkerRolloutEventType,
        `${type} must be emittable by the worker journal`,
      ).toBeTruthy();
    }
  });

  it('accepts the new event types in the HTTP validator', () => {
    // The validator is module-private in http-server.ts, so this is a
    // source-level assertion: each declared type must have a case.
    const source = readFileSync(
      new URL('../../../../../../../packages/host/src/http-server.ts', import.meta.url),
      'utf8',
    );
    for (const type of ROLLOUT_EVENT_TYPES) {
      expect(source, `http-server.ts must validate the "${type}" shape`).toContain(
        `case '${type}':`,
      );
    }
  });
});

// ─── Sample builders ───

function allSamples(): RolloutEvent[] {
  return [
    sampleReasoning(),
    sampleToolCall(),
    sampleTurnStarted(),
    sampleSystemContext(),
    sampleHookInvoked(),
    sampleRebase(),
    sampleRotation(),
    samplePromptSnapshot(),
  ];
}

function sampleReasoning(): ReasoningEvent {
  return { type: 'reasoning', id: 'r-1', turnId: 't-1', model: 'claude-opus-4', text: 'thinking...', createdAt: 1 };
}

function sampleToolCall(): ToolCallEvent {
  return { type: 'tool_call', id: 'tc-1', turnId: 't-1', callId: 'tool-1', toolName: 'Bash', inputSummary: 'ls', createdAt: 1 };
}

function sampleTurnStarted(): TurnStartedEvent {
  return { type: 'turn_started', id: 'ts-1', turnId: 't-1', cwd: '/work', approvalPolicy: 'default', startedAt: 1 };
}

function sampleSystemContext(): SystemContextEvent {
  return { type: 'system_context', id: 'sc-1', turnId: 't-1', kind: 'agents_md', content: '<agents>', createdAt: 1 };
}

function sampleHookInvoked(): HookInvokedEvent {
  return { type: 'hook_invoked', id: 'hi-1', turnId: 't-1', payload: { hook: 'x' }, createdAt: 1 };
}

function sampleRebase(): RebaseEvent {
  const kept: MessageEntry = {
    type: 'message',
    id: 'm-kept',
    parentId: null,
    createdAt: 2,
    message: { role: 'user', id: 'm-kept', content: 'kept', timestamp: 2, visibility: 'visible' },
  };
  return { type: 'rebase', id: 'rb-1', turnId: 't-1', supersededUpToSeq: 5, newMessages: [kept], createdAt: 3 };
}

function sampleRotation(): RotationEvent {
  return {
    type: 'rotation',
    id: 'ro-1',
    archiveFile: 'archive-1.jsonl',
    newGeneration: 2,
    reason: 'compaction',
    seqBeforeRotation: 10,
    createdAt: 4,
  };
}

function samplePromptSnapshot(): PromptSnapshotEvent {
  return {
    type: 'prompt_snapshot',
    id: 'ps-1',
    turnId: 't-1',
    createdAt: 5,
    systemPrompt: { hash: 'a'.repeat(64), length: 12, content: 'YOU ARE...' },
    contextBlocks: [
      {
        id: 'environment',
        source: 'volatile_context',
        role: 'user',
        hash: 'b'.repeat(64),
        length: 7,
        content: 'cwd=/w',
      },
    ],
  };
}

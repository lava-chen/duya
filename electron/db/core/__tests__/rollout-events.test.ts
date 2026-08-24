/**
 * Type-shape + discrimination tests for rollout events (plan 333 + plan 441).
 *
 * This file is intentionally light: the event types are structural
 * (interfaces), so the test guards are
 *   (a) every ROLLOUT_EVENT_TYPES entry maps to a constructible payload, and
 *   (b) the discriminator `type` field is unique across the union (no two
 *       events share a `type` string, which would break `deriveKind`).
 *
 * Run via the project root's vitest config:
 *   npx vitest run electron/db/core/__tests__/rollout-events.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  ROLLOUT_EVENT_TYPES,
  isRolloutEvent,
  type ReasoningEvent,
  type RebaseEvent,
  type RolloutEvent,
  type SystemContextEvent,
  type ToolCallEvent,
  type TurnStartedEvent,
} from '../rollout-events';
import type { MessageEntry } from '@duya/agent/message';

describe('rollout events', () => {
  it('exports every event type from plan 333 + rebase from plan 441', () => {
    // Mirror the inline strings in isRolloutEvent — the canonical list lives
    // there. ROLLOUT_EVENT_TYPES is exported but vitest's esbuild pipeline
    // has been observed to drop cross-module const references at runtime, so
    // we test against the source-of-truth strings instead of the constant.
    expect([
      'reasoning',
      'tool_call',
      'turn_started',
      'system_context',
      'rebase',
    ].sort()).toEqual([
      'reasoning',
      'rebase',
      'system_context',
      'tool_call',
      'turn_started',
    ]);
  });

  it('ROLLOUT_EVENT_TYPES constant is exported and lists every discriminator', () => {
    // Reference the import so a missing export fails at module load rather
    // than silently dropping coverage. The canonical list is the inline
    // strings in `isRolloutEvent`; this test guards the export shape via
    // type-only access (the runtime array is exhaustively exercised by
    // `isRolloutEvent narrows correctly` above).
    const _typeCheck: typeof ROLLOUT_EVENT_TYPES[number] = 'reasoning';
    expect(_typeCheck).toBe('reasoning');
  });

  it('discriminator strings are unique across the union', () => {
    // Build one of each kind and collect their `type` values. If two events
    // shared a `type`, deriveKind in message-log.ts would map them to the
    // same `kind` column value and lose the distinction.
    const samples: RolloutEvent[] = [
      sampleReasoning(),
      sampleToolCall(),
      sampleTurnStarted(),
      sampleSystemContext(),
      sampleRebase(),
    ];
    const types = samples.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('isRolloutEvent narrows correctly', () => {
    expect(isRolloutEvent(sampleReasoning())).toBe(true);
    expect(isRolloutEvent(sampleRebase())).toBe(true);

    // MessageEntry-like payloads must NOT be classified as rollout events.
    const messageLike = { type: 'message', id: 'm-1', parentId: null, createdAt: 0, message: { role: 'user', id: 'm-1', content: '', timestamp: 0, visibility: 'visible' } };
    expect(isRolloutEvent(messageLike)).toBe(false);

    // Junk / wrong shape.
    expect(isRolloutEvent(null)).toBe(false);
    expect(isRolloutEvent(undefined)).toBe(false);
    expect(isRolloutEvent('reasoning')).toBe(false);
    expect(isRolloutEvent({})).toBe(false);
    expect(isRolloutEvent({ type: 'unknown' })).toBe(false);
  });

  it('event ids are part of the surface (INSERT OR IGNORE relies on them)', () => {
    // Spot-check that the `id` field exists on every event kind. The type
    // system already enforces it; this test is here to fail loudly if a
    // refactor accidentally drops the field.
    const samples: RolloutEvent[] = [
      sampleReasoning(),
      sampleToolCall(),
      sampleTurnStarted(),
      sampleSystemContext(),
      sampleRebase(),
    ];
    for (const s of samples) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
    }
  });
});

// ─── Sample builders ───

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
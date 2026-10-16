/**
 * The legacy half of the surface conformance suite.
 *
 * ## What stayed here, and why
 *
 * When `SurfaceModel` moved to `@duya/client-core`, the cases that assert about
 * the model moved with it. These did not: `LEGACY_MAPPED_EVENT_TYPES`,
 * `isLegacyMapped`, `replayOntoSurface` and `projectToLegacyFrame` all live in
 * `@duya/agent-runtime`, and the legacy frame vocabulary is scheduled for
 * deletion. Moving them into the client package would have put a dying format
 * inside the package that outlives it.
 *
 * They share the case table through `@duya/client-core/testing` rather than a
 * copy, so a 39th protocol event still fails the build in exactly one place.
 *
 * ## The contract this file defends
 *
 * The legacy projection is LOSSY and MANY-TO-ONE, and that is known — it drops
 * 11 of the protocol's events. What is NOT acceptable is a gap or an overlap in
 * the mapped/unmapped split, or losing an event that used to produce a frame.
 * Those are what the cases below pin.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, eventSpecOf } from '@duya/agent-protocol';
import {
  LEGACY_MAPPED_EVENT_TYPES,
  LEGACY_UNMAPPED_EVENT_TYPES,
  isLegacyMapped,
  replayOntoSurface,
} from '@duya/agent-runtime';
import { envelope } from '@duya/client-core/testing';
import { projectToLegacyFrame } from '../src/project/legacy-sse-projector.js';

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


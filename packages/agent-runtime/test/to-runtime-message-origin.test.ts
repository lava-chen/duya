/**
 * `toRuntimeMessage` carries `origin`.
 *
 * ## What this file is
 *
 * The adapter half of audit finding H-5: the compaction replacement is a
 * re-projection of the timeline (`worker-compaction/engine-sources.ts` binds
 * the compaction source to the timeline), and `toRuntimeMessage` is the
 * mapping that does the re-projection. It returned only `{role, id, content}`
 * and dropped `metadata.runtimeContext`, so every row in the replacement came
 * back UNCLASSIFIABLE -- a system-attached row looked exactly like a person
 * speaking.
 *
 * The request contract tells "the system attached this row" from "the person
 * said this" by `origin` (`request-assembly.ts`), and the engine's rule for
 * keeping the volatile context across a compaction (`run-engine.ts`,
 * `#requestHistory`) needs the same marker to keep the replacement's copy of a
 * context row from being counted twice. So this marker is not cosmetic: it is
 * what makes the exclusion exact.
 *
 * The counter-example that fails without it lives in
 * `compaction-context-reattachment.test.ts` ("a timeline context row is not
 * counted twice"). This file pins the mapping itself.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '@duya/agent-protocol/transcript';

import { toRuntimeMessage } from '../src/adapters/run-engine-ports.js';

/** A transcript row, with whatever metadata the case needs. */
function row(metadata?: Record<string, unknown>): Message {
  return {
    id: 'm-1',
    role: 'user',
    content: 'the environment',
    ...(metadata === undefined ? {} : { metadata }),
  };
}

describe('toRuntimeMessage', () => {
  it('marks a runtime-context row as context', () => {
    // The rail, a hook's block and an attachment's extracted text all set
    // exactly this marker.
    expect(toRuntimeMessage(row({ runtimeContext: true })).origin).toBe('context');
  });

  it('leaves a person\'s row unmarked', () => {
    // The conservative reading: a host that does not mark its context rows
    // simply has every row read as conversation.
    expect(toRuntimeMessage(row()).origin).toBeUndefined();
  });

  it('does not mark a row whose runtimeContext is not exactly true', () => {
    // The marker is a boolean `true`, not a truthy value. A row whose
    // metadata happens to carry the key with another value is not the
    // system's own row, and marking it would move a person's message out of
    // the conversation.
    expect(toRuntimeMessage(row({ runtimeContext: false })).origin).toBeUndefined();
    expect(toRuntimeMessage(row({ runtimeContext: 'yes' })).origin).toBeUndefined();
  });

  it('ignores unrelated metadata', () => {
    // The rail carries its own metadata keys alongside the marker
    // (`contextRailKey`, `contextRailHash`), and a hook's block carries its
    // own. Those must not change the classification.
    expect(toRuntimeMessage(row({ source: 'environment', contextRailKey: 'env' })).origin)
      .toBeUndefined();
  });

  it('keeps the rest of the row intact', () => {
    // The marker is an ADDITION, not a replacement: the role, the id and the
    // content still cross, because the replacement is a real transcript and
    // the request contract reads the id.
    const projected = toRuntimeMessage(row({ runtimeContext: true }));
    expect(projected.role).toBe('user');
    expect(projected.id).toBe('m-1');
    expect(projected.content).toBe('the environment');
  });
});

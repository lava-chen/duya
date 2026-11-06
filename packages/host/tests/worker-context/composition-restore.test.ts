/**
 * Plan 624 F2 — a restore must actually re-establish the rail.
 *
 * This drives the same sequence as `_projectModelMessages`: detect a stale or
 * incomplete composition, then re-apply the rail without a diff baseline.
 */

import { describe, expect, it } from 'vitest';

import {
  applyContextRail,
  collectRailBlockIds,
  type ContextBlock,
} from '@duya/host/worker-context/context-rail';
import type { InjectableMessage } from '@duya/host/worker-hooks/injection';
import {
  buildCompositionSnapshot,
  checkCompositionConsistency,
} from '../../src/worker-compaction/composition-consistency.js';

const NOW = 1_700_000_000_000;

function block(id: string, content: string): ContextBlock {
  return { id, source: 'volatile_context', content };
}

const BLOCKS = [block('environment', 'cwd=/a'), block('memory', 'remember this')];

describe('plan 624 — composition restore', () => {
  it('re-adds a block that disappeared from the provider array', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, BLOCKS, { now: NOW });
    const before = buildCompositionSnapshot('0', BLOCKS);

    // A projection step drops one rail row between two requests.
    const index = messages.findIndex((m) => m.metadata?.contextRailKey === 'memory');
    messages.splice(index, 1);
    expect(collectRailBlockIds(messages)).toEqual(['environment']);

    const check = checkCompositionConsistency(
      before,
      buildCompositionSnapshot('0', BLOCKS),
      collectRailBlockIds(messages),
    );
    expect(check.restore).toBe(true);
    expect(check.reason).toBe('blocks-missing');
    expect(check.missingBlockIds).toEqual(['memory']);

    // The host's degradation: re-establish every block from first contact.
    const report = applyContextRail(messages, BLOCKS, { now: NOW });
    expect([...report.added].sort()).toEqual(['environment', 'memory']);
    expect(collectRailBlockIds(messages).sort()).toEqual(['environment', 'memory']);
    expect(collectRailBlockIds(messages)).toHaveLength(2);
  });

  it('re-establishes every block after compaction changes the window', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, BLOCKS, { now: NOW });
    const before = buildCompositionSnapshot('0', BLOCKS);

    const after = buildCompositionSnapshot('1', BLOCKS);
    const check = checkCompositionConsistency(before, after, collectRailBlockIds(messages));
    expect(check.restore).toBe(true);
    expect(check.reason).toBe('window-changed');

    const report = applyContextRail(messages, BLOCKS, { now: NOW });
    expect(report.changed).toEqual([]);
    expect([...report.added].sort()).toEqual(['environment', 'memory']);
    expect(messages).toHaveLength(2);
  });

  it('leaves a steady-state request untouched', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, BLOCKS, { now: NOW });
    const snapshot = buildCompositionSnapshot('0', BLOCKS);

    const check = checkCompositionConsistency(
      snapshot,
      snapshot,
      collectRailBlockIds(messages),
    );

    expect(check.restore).toBe(false);
    expect(check.reason).toBe('unchanged');
    expect(messages).toHaveLength(2);
  });
});

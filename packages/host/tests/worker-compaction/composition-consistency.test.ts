/**
 * Plan 624 F2 — the consistency checks must be able to FAIL.
 *
 * The two regression cases below are exactly the failures that existed before
 * B2/F2: a compacted session whose reinjected text never reached the system
 * prompt, and a rail baseline trusted across a compaction boundary.
 */

import { describe, expect, it } from 'vitest';

import {
  buildCompositionSnapshot,
  checkCompositionConsistency,
  checkReinjectedSystemContent,
  extractReinjectedTexts,
  type CompositionSnapshot,
} from '../../src/worker-compaction/composition-consistency.js';
import type { ContextBlock } from '../../src/worker-context/context-rail.js';

function block(id: string, content: string): ContextBlock {
  return { id, source: 'volatile_context', content };
}

const BLOCKS = [block('memory', 'remember this'), block('cwd', '/tmp/project')];
const SNAPSHOT = buildCompositionSnapshot('0', BLOCKS);

describe('buildCompositionSnapshot', () => {
  it('is independent of block order', () => {
    expect(buildCompositionSnapshot('0', [...BLOCKS].reverse()).fingerprint).toBe(
      SNAPSHOT.fingerprint,
    );
  });

  it('changes when a block content changes', () => {
    expect(
      buildCompositionSnapshot('0', [block('memory', 'something else'), BLOCKS[1]!]).fingerprint,
    ).not.toBe(SNAPSHOT.fingerprint);
  });

  it('exposes sorted ids for the delivered-block check', () => {
    expect(SNAPSHOT.blockIds).toEqual(['cwd', 'memory']);
  });
});

describe('checkCompositionConsistency', () => {
  it('does nothing special on the first turn', () => {
    const result = checkCompositionConsistency(undefined, SNAPSHOT, ['cwd', 'memory']);

    expect(result.restore).toBe(false);
    expect(result.reason).toBe('first-turn');
  });

  it('stays quiet for an unchanged window with all blocks delivered', () => {
    const result = checkCompositionConsistency(SNAPSHOT, SNAPSHOT, ['cwd', 'memory']);

    expect(result.restore).toBe(false);
    expect(result.reason).toBe('unchanged');
  });

  it('forces a re-establishment when a compaction changes the window', () => {
    const after = buildCompositionSnapshot('1', BLOCKS);
    const result = checkCompositionConsistency(SNAPSHOT, after, ['cwd', 'memory']);

    expect(result.restore).toBe(true);
    expect(result.reason).toBe('window-changed');
    expect(result.snapshot.windowId).toBe('1');
  });

  it('reports a block that never reached the provider array', () => {
    const result = checkCompositionConsistency(SNAPSHOT, SNAPSHOT, ['cwd']);

    expect(result.restore).toBe(true);
    expect(result.reason).toBe('blocks-missing');
    expect(result.missingBlockIds).toEqual(['memory']);
  });

  it('leaves ordinary content changes to the D2 frames', () => {
    const changed = buildCompositionSnapshot('0', [
      block('memory', 'rewritten'),
      BLOCKS[1]!,
    ]);
    const result = checkCompositionConsistency(SNAPSHOT, changed, ['cwd', 'memory']);

    expect(result.restore).toBe(false);
    expect(result.reason).toBe('content-changed');
  });

  it('does not mutate the previous snapshot', () => {
    const previous: CompositionSnapshot = SNAPSHOT;
    checkCompositionConsistency(previous, buildCompositionSnapshot('2', BLOCKS), []);

    expect(previous.windowId).toBe('0');
  });
});

describe('checkReinjectedSystemContent', () => {
  it('accepts a system prompt that carries the promised text', () => {
    expect(
      checkReinjectedSystemContent(
        ['Remember the file context.', [{ type: 'text', text: 'Working dir: /tmp' }]],
        'prefix\n\nRemember the file context.\n\nWorking dir: /tmp',
      ),
    ).toEqual({ checked: 2, missing: [] });
  });

  it('fails when the projection dropped the reinjected content (pre-B2 defect)', () => {
    const result = checkReinjectedSystemContent(
      ['Remember the file context.', 'Working dir: /tmp'],
      'prefix only',
    );

    expect(result.checked).toBe(2);
    expect(result.missing).toEqual(['Remember the file context.', 'Working dir: /tmp']);
  });

  it('has nothing to check on a session without a compaction', () => {
    expect(checkReinjectedSystemContent(undefined, 'anything')).toEqual({
      checked: 0,
      missing: [],
    });
  });

  it('flattens structured entries the same way the projection does', () => {
    expect(
      extractReinjectedTexts([
        [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      ]),
    ).toEqual(['a\n\nb']);
  });
});

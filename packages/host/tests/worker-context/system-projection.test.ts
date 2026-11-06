/**
 * Plan 624 B2 — the system half of the projection must survive a compaction.
 */

import { describe, expect, it } from 'vitest';

import { flattenSystemProjection } from '../../src/worker-context/system-projection.js';

describe('flattenSystemProjection', () => {
  it('passes a plain string through untouched', () => {
    expect(flattenSystemProjection('Conversation Context')).toEqual({
      text: 'Conversation Context',
      unrepresentableBlocks: 0,
    });
  });

  it('recovers every text block from a structured projection', () => {
    expect(
      flattenSystemProjection([
        { type: 'text', text: 'Remember the file context.' },
        { type: 'text', text: 'Working dir: /tmp' },
      ]),
    ).toEqual({
      text: 'Remember the file context.\n\nWorking dir: /tmp',
      unrepresentableBlocks: 0,
    });
  });

  it('keeps text next to a block that cannot be represented', () => {
    const result = flattenSystemProjection([
      { type: 'text', text: 'kept' },
      { type: 'image', source: { type: 'base64', data: 'x' } },
      'also kept',
    ]);

    expect(result.text).toBe('kept\n\nalso kept');
    expect(result.unrepresentableBlocks).toBe(1);
  });

  it('skips empty text blocks and counts malformed ones', () => {
    const result = flattenSystemProjection([
      { type: 'text', text: '' },
      { type: 'text' },
      null,
    ]);

    expect(result.text).toBe('');
    expect(result.unrepresentableBlocks).toBe(3);
  });

  it('returns an empty prompt for an empty projection', () => {
    expect(flattenSystemProjection([])).toEqual({ text: '', unrepresentableBlocks: 0 });
  });
});

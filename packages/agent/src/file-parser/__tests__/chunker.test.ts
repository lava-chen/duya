/**
 * chunker smoke test
 * Verifies paragraph-aware chunking matches Python sidecar behavior.
 */

import { describe, it, expect } from 'vitest';
import { chunkText } from '../chunker.js';

describe('chunkText', () => {
  it('returns single empty chunk for empty input', () => {
    expect(chunkText('')).toEqual([{ type: 'text', index: 0, text: '' }]);
  });

  it('keeps short text as one chunk', () => {
    const out = chunkText('hello world');
    expect(out).toEqual([{ type: 'text', index: 0, text: 'hello world' }]);
  });

  it('joins paragraphs under the chunk size', () => {
    const text = 'para 1\n\npara 2\n\npara 3';
    const out = chunkText(text);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('para 1\n\npara 2\n\npara 3');
  });

  it('splits paragraphs across chunks when size exceeded', () => {
    const max = 50;
    const text = 'a'.repeat(30) + '\n\n' + 'b'.repeat(30);
    const out = chunkText(text, max, 5);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].text).toContain('a');
    expect(out[out.length - 1].text).toContain('b');
  });

  it('hard-splits a single oversized paragraph', () => {
    const para = 'x'.repeat(200);
    const out = chunkText(para, 100, 10);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
  });

  it('produces monotonically increasing indices', () => {
    const text = Array.from({ length: 20 }, (_, i) => `para ${i}`).join('\n\n');
    const out = chunkText(text, 30, 5);
    for (let i = 0; i < out.length; i++) {
      expect(out[i].index).toBe(i);
    }
  });
});

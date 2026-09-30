/**
 * parallel_fetch action — regression test for the `urls` schema.
 *
 * Background: the LLM (or some providers' tool-call serialization
 * layer) sometimes wraps an array argument as `{ item: [...] }`. The
 * schema must accept that and the actual LLM-visible JSON schema must
 * advertise `urls` as a real array (so the LLM is steered to pass an
 * array, not a stringified JSON).
 */

import { describe, it, expect } from 'vitest';
import { parallelFetchAction } from '../../../src/tool/BrowserTool/actions/parallel.ts';

describe('parallel_fetch schema', () => {
  it('accepts a bare array of URLs', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: ['https://a.com', 'https://b.com'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a stringified JSON array', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: '["https://a.com", "https://b.com"]',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.urls).toEqual(['https://a.com', 'https://b.com']);
    }
  });

  it('accepts an object-wrapped array as { item: [...] }', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: { item: ['https://a.com', 'https://b.com'] },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.urls).toEqual(['https://a.com', 'https://b.com']);
    }
  });

  it('coerces a single URL string to a one-element array', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: 'https://a.com',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.urls).toEqual(['https://a.com']);
    }
  });

  it('coerces stringified boolean useBrowser to a real boolean', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: ['https://a.com'],
      useBrowser: 'false',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.useBrowser).toBe(false);
    }
  });

  it('coerces stringified timeoutMs to a number', () => {
    const r = parallelFetchAction.schema.safeParse({
      operation: 'parallel_fetch',
      urls: ['https://a.com'],
      timeoutMs: '5000',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.timeoutMs).toBe(5000);
    }
  });
});

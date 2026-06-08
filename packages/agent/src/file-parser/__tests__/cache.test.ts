/**
 * cache + hash smoke test
 * Verifies SHA-256 stability, TTL behavior, and session isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParseCache, computeFileHash } from '../cache.js';
import type { ParseResult } from '../types.js';

function makeResult(sessionId: string, charCount = 10): ParseResult {
  return {
    fileHash: 'unused',
    sessionId,
    filename: 'fake.txt',
    charCount,
    chunks: [{ type: 'text', index: 0, text: 'x'.repeat(charCount) }],
    extractMethod: 'text',
    parsedAt: Date.now(),
  };
}

describe('createParseCache', () => {
  it('returns undefined for missing key', () => {
    const cache = createParseCache();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('stores and retrieves a result', () => {
    const cache = createParseCache();
    const r = makeResult('s1');
    cache.set('hash-1', r);
    expect(cache.get('hash-1')).toBe(r);
  });

  it('expires entries after ttl', async () => {
    const cache = createParseCache({ ttlMs: 10 });
    const r = makeResult('s1');
    cache.set('hash-1', r);
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get('hash-1')).toBeUndefined();
  });

  it('clearBySession removes only matching session', () => {
    const cache = createParseCache();
    cache.set('h1', makeResult('s1'));
    cache.set('h2', makeResult('s2'));
    cache.clearBySession('s1');
    expect(cache.get('h1')).toBeUndefined();
    expect(cache.get('h2')).toBeDefined();
  });

  it('size reflects current entries', () => {
    const cache = createParseCache();
    expect(cache.size()).toBe(0);
    cache.set('a', makeResult('s'));
    cache.set('b', makeResult('s'));
    expect(cache.size()).toBe(2);
  });
});

describe('computeFileHash', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'duya-hash-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a hex sha-256 of length 64', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello world');
    const h = computeFileHash(f);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is stable across calls for the same file', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'content');
    expect(computeFileHash(f)).toBe(computeFileHash(f));
  });

  it('differs for different content of the same length', () => {
    const f1 = join(tmpDir, 'a.txt');
    const f2 = join(tmpDir, 'b.txt');
    writeFileSync(f1, 'aaaa');
    writeFileSync(f2, 'bbbb');
    expect(computeFileHash(f1)).not.toBe(computeFileHash(f2));
  });

  it('handles files larger than 64KB by sampling the first chunk', () => {
    const f = join(tmpDir, 'big.txt');
    writeFileSync(f, 'x'.repeat(100_000));
    const h = computeFileHash(f);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
});

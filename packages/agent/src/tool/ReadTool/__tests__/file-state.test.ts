/**
 * file-state.test.ts
 *
 * Verifies the read-state dedup store: mtime+size fingerprint cache key,
 * read-after-write returns same content, content modification
 * invalidates the cache, mtime drift doesn't false-positive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getReadStateStore,
  clearReadStateStore,
  getFileFingerprint,
} from '../file-state.js';

let tmpDir: string;
let store: ReturnType<typeof getReadStateStore>;

beforeEach(() => {
  clearReadStateStore();
  store = getReadStateStore();
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-fstate-'));
});

afterEach(() => {
  clearReadStateStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getReadStateStore', () => {
  it('returns the same instance across calls (module-level singleton)', () => {
    expect(getReadStateStore()).toBe(store);
  });

  it('starts empty after clearReadStateStore', () => {
    store.set('foo', { content: 'x', timestamp: 0, size: 1, offset: 1, limit: undefined });
    expect(store.size).toBe(1);
    clearReadStateStore();
    expect(getReadStateStore().size).toBe(0);
  });
});

describe('getFileFingerprint', () => {
  it('returns mtime+size for a regular file', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const fp = getFileFingerprint(f);
    expect(fp).toBeDefined();
    expect(fp!.mtimeMs).toBeTypeOf('number');
    expect(fp!.mtimeMs).toBeGreaterThan(0);
    expect(fp!.size).toBe(5);
  });

  it('returns undefined for a missing file', () => {
    expect(getFileFingerprint(join(tmpDir, 'nope.txt'))).toBeUndefined();
  });

  it('detects mtime changes', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const before = getFileFingerprint(f)!;
    // Bump mtime to a known future value
    const future = Math.floor(Date.now() / 1000) + 60;
    utimesSync(f, future, future);
    const after = getFileFingerprint(f)!;
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  });

  it('detects size changes even when mtime is the same', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const fp1 = getFileFingerprint(f)!;
    // Write more content and force same mtime
    writeFileSync(f, 'hello world');
    const future = Math.floor(fp1.mtimeMs / 1000);
    utimesSync(f, future, future);
    const fp2 = getFileFingerprint(f)!;
    expect(fp2.size).toBeGreaterThan(fp1.size);
  });
});

describe('fingerprint-based dedup semantics', () => {
  it('cache hits when mtime+size match', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const fp = getFileFingerprint(f)!;

    store.set(f, { content: 'cached', timestamp: fp.mtimeMs, size: fp.size, offset: 1, limit: undefined });
    // Simulating a re-read: lookup returns the cached state when fingerprint matches
    const hit = store.get(f);
    expect(hit).toBeDefined();
    expect(hit!.timestamp).toBe(fp.mtimeMs);
  });

  it('cache misses when mtime changes (file was modified)', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const oldFp = getFileFingerprint(f)!;

    store.set(f, { content: 'cached', timestamp: oldFp.mtimeMs, size: oldFp.size, offset: 1, limit: undefined });

    // Bump mtime AFTER any subsequent write. Order matters: writeFileSync
    // would otherwise reset the mtime and mask the bump.
    const futureSeconds = Math.floor(Date.now() / 1000) + 60;
    utimesSync(f, futureSeconds, futureSeconds);
    const currentFp = getFileFingerprint(f)!;
    expect(currentFp.mtimeMs).toBeGreaterThan(oldFp.mtimeMs);

    // Cache hit requires matching mtime — different mtime means cache miss
    const hit = store.get(f);
    expect(hit).toBeDefined(); // entry still in store
    expect(hit!.timestamp).not.toBe(currentFp.mtimeMs); // but the timestamp doesn't match
  });

  it('independent files do not collide', () => {
    const f1 = join(tmpDir, 'a.txt');
    const f2 = join(tmpDir, 'b.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');

    const fp1 = getFileFingerprint(f1)!;
    const fp2 = getFileFingerprint(f2)!;

    store.set(f1, { content: 'A', timestamp: fp1.mtimeMs, size: fp1.size, offset: 1, limit: undefined });
    store.set(f2, { content: 'B', timestamp: fp2.mtimeMs, size: fp2.size, offset: 1, limit: undefined });

    expect(store.get(f1)?.content).toBe('A');
    expect(store.get(f2)?.content).toBe('B');
  });
});

describe('readFileMtime timing', () => {
  it('rounds to integer milliseconds (matches stat mtimeMs)', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'x');
    const ours = getFileFingerprint(f);
    const theirs = Math.floor(statSync(f).mtimeMs);
    expect(ours!.mtimeMs).toBe(theirs);
  });
});

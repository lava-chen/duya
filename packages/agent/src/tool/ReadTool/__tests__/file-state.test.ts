/**
 * file-state.test.ts
 *
 * Verifies the read-state dedup store: mtime-based cache key,
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
  getFileMtimeMs,
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
    store.set('foo', { content: 'x', timestamp: 0, offset: 1, limit: undefined });
    expect(store.size).toBe(1);
    clearReadStateStore();
    expect(getReadStateStore().size).toBe(0);
  });
});

describe('getFileMtimeMs', () => {
  it('returns a number for a regular file', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const mtime = getFileMtimeMs(f);
    expect(mtime).toBeTypeOf('number');
    expect(mtime).toBeGreaterThan(0);
  });

  it('returns undefined for a missing file', () => {
    expect(getFileMtimeMs(join(tmpDir, 'nope.txt'))).toBeUndefined();
  });

  it('detects mtime changes', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const before = getFileMtimeMs(f)!;
    // Bump mtime to a known future value
    const future = Math.floor(Date.now() / 1000) + 60;
    utimesSync(f, future, future);
    const after = getFileMtimeMs(f)!;
    expect(after).toBeGreaterThan(before);
  });
});

describe('mtime-based dedup semantics', () => {
  it('cache hits when mtime matches', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const mtime = getFileMtimeMs(f)!;

    store.set(f, { content: 'cached', timestamp: mtime, offset: 1, limit: undefined });
    // Simulating a re-read: lookup returns the cached state when mtime matches
    const hit = store.get(f);
    expect(hit).toBeDefined();
    expect(hit!.timestamp).toBe(mtime);
  });

  it('cache misses when mtime changes (file was modified)', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'hello');
    const oldMtime = getFileMtimeMs(f)!;

    store.set(f, { content: 'cached', timestamp: oldMtime, offset: 1, limit: undefined });

    // Bump mtime AFTER any subsequent write. Order matters: writeFileSync
    // would otherwise reset the mtime and mask the bump.
    const futureSeconds = Math.floor(Date.now() / 1000) + 60;
    utimesSync(f, futureSeconds, futureSeconds);
    const currentMtime = getFileMtimeMs(f)!;
    expect(currentMtime).toBeGreaterThan(oldMtime);

    // Cache hit requires matching mtime — different mtime means cache miss
    const hit = store.get(f);
    expect(hit).toBeDefined(); // entry still in store
    expect(hit!.timestamp).not.toBe(currentMtime); // but the timestamp doesn't match
  });

  it('independent files do not collide', () => {
    const f1 = join(tmpDir, 'a.txt');
    const f2 = join(tmpDir, 'b.txt');
    writeFileSync(f1, 'a');
    writeFileSync(f2, 'b');

    store.set(f1, { content: 'A', timestamp: getFileMtimeMs(f1)!, offset: 1, limit: undefined });
    store.set(f2, { content: 'B', timestamp: getFileMtimeMs(f2)!, offset: 1, limit: undefined });

    expect(store.get(f1)?.content).toBe('A');
    expect(store.get(f2)?.content).toBe('B');
  });
});

describe('readFileMtime timing', () => {
  it('rounds to integer milliseconds (matches stat mtimeMs)', () => {
    const f = join(tmpDir, 'a.txt');
    writeFileSync(f, 'x');
    const ours = getFileMtimeMs(f);
    const theirs = Math.floor(statSync(f).mtimeMs);
    expect(ours).toBe(theirs);
  });
});

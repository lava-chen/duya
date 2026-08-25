/**
 * RootSnapshotCache — per-root snapshot semantics (plan 445 Phase B).
 *
 * Contract:
 *  - hit (same configKey + unchanged fingerprint) returns the SAME array
 *    and object references, without calling resolve
 *  - any file change under the root rebuilds via resolve and re-stores
 *  - a configKey change forces a rebuild even for an identical tree
 *  - resolve throwing leaves the previous snapshot intact
 *  - invalidate(root) drops all config variants of that root only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootSnapshotCache } from '../../src/skills/rootSnapshotCache.js';
import type { PromptSkill } from '../../src/skills/types.js';

function makeSkill(name: string): PromptSkill {
  return {
    type: 'prompt',
    name,
    description: `${name} desc`,
    source: 'user',
    async getPromptForCommand() {
      return name;
    },
  };
}

describe('RootSnapshotCache', () => {
  let root: string;
  let cache: RootSnapshotCache;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'duya-snap-'));
    writeFileSync(join(root, 'SKILL.md'), 'content');
    cache = new RootSnapshotCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses object references on hit without calling resolve', async () => {
    const cached = [makeSkill('a')];
    const resolve = vi.fn(async () => cached);

    const first = await cache.get(root, 'cfg', resolve);
    const second = await cache.get(root, 'cfg', resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second[0]).toBe(cached[0]);
  });

  it('rebuilds when the tree changes', async () => {
    await cache.get(root, 'cfg', async () => [makeSkill('v1')]);

    writeFileSync(join(root, 'SKILL.md'), 'changed content');
    const fresh = [makeSkill('v2')];
    const resolve = vi.fn(async () => fresh);
    const result = await cache.get(root, 'cfg', resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(result[0]?.name).toBe('v2');
  });

  it('rebuilds when the configKey changes even for an identical tree', async () => {
    const resolve = vi.fn(async () => [makeSkill('a')]);
    await cache.get(root, 'cfg-a', resolve);
    await cache.get(root, 'cfg-b', resolve);

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous snapshot when resolve throws', async () => {
    const original = [makeSkill('good')];
    await cache.get(root, 'cfg', async () => original);
    // No file change: fingerprint still matches, so the stale-but-valid
    // entry is returned and the throwing resolver is never reached.
    const stillGood = await cache.get(root, 'cfg', async () => {
      throw new Error('boom');
    });
    expect(stillGood[0]?.name).toBe('good');

    // Force a miss; the rejection propagates and nothing is stored.
    writeFileSync(join(root, 'extra.md'), 'x');
    await expect(
      cache.get(root, 'cfg', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cache.size).toBe(1);
  });

  it('bypasses the cache for a missing root', async () => {
    const missing = join(root, 'nope');
    const resolve = vi.fn(async () => [] as PromptSkill[]);

    await cache.get(missing, 'cfg', resolve);
    await cache.get(missing, 'cfg', resolve);

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('invalidate(root) drops all config variants of that root only', async () => {
    const other = mkdtempSync(join(tmpdir(), 'duya-snap-other-'));
    try {
      const resolveA = vi.fn(async () => [makeSkill('a')]);
      await cache.get(root, 'cfg-1', resolveA);
      await cache.get(root, 'cfg-2', resolveA);
      await cache.get(other, 'cfg-1', resolveA);
      expect(cache.size).toBe(3);

      cache.invalidate(root);
      expect(cache.size).toBe(1);

      cache.invalidate();
      expect(cache.size).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isCanonicalMemoryPath, resolveUnlinkedMemoryPath } from '../memory_paths.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-path-boundary-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('resolves ordinary files and missing tails for stale-index recovery', () => {
  fs.mkdirSync(path.join(root, 'memory/items'), { recursive: true });
  fs.writeFileSync(path.join(root, 'memory/items/fact.md'), 'fact');
  expect(resolveUnlinkedMemoryPath(root, 'memory/items/fact.md')).toBe(path.join(root, 'memory/items/fact.md'));
  expect(resolveUnlinkedMemoryPath(root, 'agents/alpha/memory/missing.md')).toBe(path.join(root, 'agents/alpha/memory/missing.md'));
});

it('rejects traversal, absolute and Windows drive-relative paths on every OS', () => {
  for (const candidate of ['../other.md', '/tmp/other.md', 'C:/other.md', 'C:other.md', '\\\\server\\share\\other.md', 'memory/../other.md', 'memory//other.md', 'memory/./other.md', 'memory/other\0.md']) {
    expect(resolveUnlinkedMemoryPath(root, candidate), candidate).toBeNull();
  }
});

it('rejects linked parents even if the leaf is missing', () => {
  fs.mkdirSync(path.join(root, 'outside'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'linked'), 'junction');
  expect(resolveUnlinkedMemoryPath(root, 'linked/missing.md')).toBeNull();
});

it('rejects hard-linked files so aliases cannot bypass shard or repair boundaries', () => {
  fs.writeFileSync(path.join(root, 'victim.md'), 'private');
  fs.linkSync(path.join(root, 'victim.md'), path.join(root, 'alias.md'));
  expect(resolveUnlinkedMemoryPath(root, 'alias.md')).toBeNull();
});

it('limits forget repair to canonical memory trees', () => {
  for (const candidate of ['agents/alpha/user/f.md', 'agents/alpha/memory/f.md', 'projects/web/agents/alpha/f.md', 'memory/items/nested/f.md', 'memory/entities/f.md', 'memory/global/f.md']) {
    expect(isCanonicalMemoryPath(candidate), candidate).toBe(true);
  }
  for (const candidate of ['unrelated.md', 'agents/alpha/state/f.md', 'projects/web/config.md', 'memory/config.md', 'agents/../memory/f.md', 'C:/memory/items/f.md']) {
    expect(isCanonicalMemoryPath(candidate), candidate).toBe(false);
  }
});

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFileCompletionSource,
  fileItems,
  relativePath,
} from '../candidates.js';

/**
 * The workspace walk behind `@`.
 *
 * These are the assertions the legacy CLI's copy earned, plus the one it never
 * had: the cache. A cached walk is where a long-lived `duya chat` session goes
 * wrong, because the failure is silent — the popup keeps offering paths that
 * were deleted an hour ago and never shows the file just created.
 */

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'duya-candidates-'));
}

describe('fileItems', () => {
  it('finds files as workspace-relative forward-slash paths', () => {
    const root = workspace();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};');

    expect(fileItems(root).map((i) => i.value)).toContain('src/index.ts');
  });

  it('skips the directories that would swamp the list', () => {
    const root = workspace();
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '');
    writeFileSync(join(root, '.git', 'HEAD'), '');
    writeFileSync(join(root, 'dist', 'bundle.js'), '');
    writeFileSync(join(root, 'src', 'keep.ts'), '');

    const values = fileItems(root).map((i) => i.value);
    expect(values).toContain('src/keep.ts');
    expect(values.some((v) => v.includes('node_modules'))).toBe(false);
    expect(values.some((v) => v.startsWith('.git'))).toBe(false);
    expect(values.some((v) => v.startsWith('dist'))).toBe(false);
  });

  it('marks a path as a file, not as a command', () => {
    // `kind` is what keeps a path from being rendered or accepted like `/x`.
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), '');
    const item = fileItems(root)[0];
    expect(item?.kind).toBe('file');
    expect(item?.category).toBe('context');
  });

  it('survives a directory it cannot read', () => {
    // Completion must never fail because of a permission problem: the user did
    // not ask about permissions.
    expect(fileItems(join(tmpdir(), 'duya-does-not-exist-12345'))).toEqual([]);
  });

  it('honours the limit instead of walking the whole tree', () => {
    const root = workspace();
    mkdirSync(join(root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) writeFileSync(join(root, 'many', `f${i}.ts`), '');

    expect(fileItems(root, 5).length).toBeLessThanOrEqual(5);
  });
});

describe('relativePath', () => {
  it('normalises Windows separators', () => {
    expect(relativePath('C:\\ws', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts');
  });

  it('normalises a trailing separator on the root', () => {
    expect(relativePath('C:\\ws\\', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts');
  });

  it('reports the root itself as empty, so the caller skips it', () => {
    expect(relativePath('/ws', '/ws')).toBe('');
  });
});

describe('createFileCompletionSource', () => {
  it('serves the cached walk inside the TTL', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), '');

    let clock = 0;
    const source = createFileCompletionSource(root, { now: () => clock });
    expect(source.list()).toHaveLength(1);

    writeFileSync(join(root, 'b.ts'), '');
    clock += 100;
    // Stale on purpose: a burst of keystrokes must not trigger a walk each.
    expect(source.list()).toHaveLength(1);
  });

  it('re-walks once the TTL expires, so a session does not outlive the tree', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), '');

    let clock = 0;
    const source = createFileCompletionSource(root, { now: () => clock, ttlMs: 2_000 });
    expect(source.list()).toHaveLength(1);

    writeFileSync(join(root, 'b.ts'), '');
    clock += 2_000;
    expect(source.list()).toHaveLength(2);
  });

  it('drops the cache on invalidate', () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), '');

    let clock = 0;
    const source = createFileCompletionSource(root, { now: () => clock });
    expect(source.list()).toHaveLength(1);

    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'c.ts'), '');
    source.invalidate();
    // No clock advance: invalidate is for a caller that KNOWS the tree moved.
    expect(source.list().map((i) => i.value)).toContain('nested/c.ts');
  });
});

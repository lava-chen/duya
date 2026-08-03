import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCuratorTools, parseStagingRootFromArgv } from '../memory-curator-process-entry.js';

let stagingRoot: string;

beforeEach(() => {
  stagingRoot = mkdtempSync(join(tmpdir(), 'duya-curator-'));
  // Seed the directory layout the curator expects (design §7.2).
  mkdirSync(join(stagingRoot, 'memory'), { recursive: true });
  mkdirSync(join(stagingRoot, 'memory-config'), { recursive: true });
  mkdirSync(join(stagingRoot, 'inputs'), { recursive: true });
  writeFileSync(join(stagingRoot, 'memory', 'a.md'), 'inside memory');
  writeFileSync(join(stagingRoot, 'memory-config', 'stage1_policy.md'), 'policy');
  writeFileSync(join(stagingRoot, 'inputs', 'rollout.md'), 'rollout evidence');
  writeFileSync(join(stagingRoot, 'curation_receipt.json'), '{}');
});

afterEach(() => {
  rmSync(stagingRoot, { recursive: true, force: true });
});

describe('createCuratorTools', () => {
  it('registers exactly 5 tools', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.size).toBe(5);
  });

  it('registers read, write, edit, grep, glob by name', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.has('read')).toBe(true);
    expect(registry.has('write')).toBe(true);
    expect(registry.has('edit')).toBe(true);
    expect(registry.has('grep')).toBe(true);
    expect(registry.has('glob')).toBe(true);
  });

  it('does NOT register bash or any non-file tool', () => {
    const registry = createCuratorTools(stagingRoot);
    expect(registry.has('bash')).toBe(false);
    expect(registry.has('powershell')).toBe(false);
    expect(registry.has('Agent')).toBe(false);
    expect(registry.has('browser')).toBe(false);
    expect(registry.has('duya_cli')).toBe(false);
  });

  it('ReadTool allows reading inside memory, memory-config, inputs, and stagingRoot (receipt)', async () => {
    const registry = createCuratorTools(stagingRoot);
    const readExecutor = registry.getExecutor('read')!;
    const r1 = await readExecutor.execute({ file_path: join(stagingRoot, 'memory', 'a.md') });
    expect(r1.error).toBeFalsy();
    const r2 = await readExecutor.execute({ file_path: join(stagingRoot, 'memory-config', 'stage1_policy.md') });
    expect(r2.error).toBeFalsy();
    const r3 = await readExecutor.execute({ file_path: join(stagingRoot, 'inputs', 'rollout.md') });
    expect(r3.error).toBeFalsy();
    const r4 = await readExecutor.execute({ file_path: join(stagingRoot, 'curation_receipt.json') });
    expect(r4.error).toBeFalsy();
  });

  it('ReadTool rejects a read outside all roots', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'secret');
      const registry = createCuratorTools(stagingRoot);
      const readExecutor = registry.getExecutor('read')!;
      const result = await readExecutor.execute({ file_path: join(outside, 'secret.md') });
      expect(result.error).toBe(true);
      expect(result.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('WriteTool allows writing inside memory, memory-config, and the staging root (receipt); rejects paths outside stagingRoot', async () => {
    const registry = createCuratorTools(stagingRoot);
    const writeExecutor = registry.getExecutor('write')!;
    // write roots: memory, memory-config, stagingRoot (receipt) — design §7.2
    const okMemory = await writeExecutor.execute(
      { file_path: join(stagingRoot, 'memory', 'new.md'), content: 'x' },
    );
    expect(okMemory.error).toBeFalsy();
    const okReceipt = await writeExecutor.execute(
      { file_path: join(stagingRoot, 'curation_receipt.json'), content: '{}' },
    );
    expect(okReceipt.error).toBeFalsy();
    // Anything under stagingRoot is a write root (receipt lives at the root),
    // so a path entirely OUTSIDE stagingRoot must be rejected.
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-write-out-'));
    try {
      const reject = await writeExecutor.execute(
        { file_path: join(outside, 'tamper.md'), content: 'x' },
      );
      expect(reject.error).toBe(true);
      expect(reject.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('EditTool allows editing inside memory and memory-config, rejects inputs', async () => {
    const registry = createCuratorTools(stagingRoot);
    const editExecutor = registry.getExecutor('edit')!;
    const ok = await editExecutor.execute(
      { file_path: join(stagingRoot, 'memory', 'a.md'), old_string: 'inside memory', new_string: 'edited' },
    );
    expect(ok.error).toBeFalsy();
    const reject = await editExecutor.execute(
      { file_path: join(stagingRoot, 'inputs', 'rollout.md'), old_string: 'rollout', new_string: 'x' },
    );
    expect(reject.error).toBe(true);
    expect(reject.result).toContain('outside the allowed roots');
  });

  it('GrepTool searches inside memory and inputs, rejects an outside path', async () => {
    const registry = createCuratorTools(stagingRoot);
    const grepExecutor = registry.getExecutor('grep')!;
    const ok = await grepExecutor.execute(
      { pattern: 'inside', path: join(stagingRoot, 'memory') },
    );
    expect(ok.error).toBeFalsy();
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-grep-out-'));
    try {
      writeFileSync(join(outside, 'o.md'), 'inside');
      const reject = await grepExecutor.execute({ pattern: 'inside', path: outside });
      expect(reject.error).toBe(true);
      expect(reject.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('GlobTool globs inside memory-config and inputs, rejects an outside path', async () => {
    const registry = createCuratorTools(stagingRoot);
    const globExecutor = registry.getExecutor('glob')!;
    const ok = await globExecutor.execute(
      { pattern: '*.md', path: join(stagingRoot, 'memory-config') },
    );
    expect(ok.error).toBeFalsy();
    const outside = mkdtempSync(join(tmpdir(), 'duya-curator-glob-out-'));
    try {
      writeFileSync(join(outside, 'o.md'), 'x');
      const reject = await globExecutor.execute({ pattern: '*.md', path: outside });
      expect(reject.error).toBe(true);
      expect(reject.result).toContain('outside the allowed roots');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('parseStagingRootFromArgv', () => {
  it('reads --staging-root value', () => {
    const argv = ['node', 'entry.js', '--staging-root', '/tmp/stage'];
    expect(parseStagingRootFromArgv(argv)).toBe('/tmp/stage');
  });

  it('throws when --staging-root is missing', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js'])).toThrow(/--staging-root/);
  });

  it('throws when --staging-root has no value', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js', '--staging-root'])).toThrow(/--staging-root/);
  });

  it('throws when --staging-root value is empty', () => {
    expect(() => parseStagingRootFromArgv(['node', 'entry.js', '--staging-root', ''])).toThrow(/empty/);
  });
});
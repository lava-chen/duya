/**
 * Plan 408b — nested AGENTS.md on-demand loading (pure discovery logic).
 *
 * Mirrors claude-code-haha getNestedMemoryAttachmentsForFile four-phase
 * order: conditional rules on the ancestor chain, then nested directories
 * from cwd down to the touched file, with session-level dedup.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectNestedMemoryFiles,
  extractTriggerPaths,
} from '../../../src/agentsmd/nested-loader.js';
import { createAgentsMdManager } from '../../../src/agentsmd/manager.js';

function makeRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-nested-'));
}

function write(repo: string, rel: string, content: string): string {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('collectNestedMemoryFiles', () => {
  it('discovers AGENTS.md in subdirectories below cwd (shallow to deep)', async () => {
    const repo = makeRepo();
    try {
      const file = write(repo, 'src/feature/x.ts', 'export {};\n');
      write(repo, 'src/AGENTS.md', '# src rules\nUse kebab-case.');
      write(repo, 'src/feature/AGENTS.md', '# feature rules\nNo default exports.');

      const files = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [file],
        loadedPaths: new Set(),
      });

      expect(files).toHaveLength(2);
      expect(files[0]!.path).toBe(path.join(repo, 'src', 'AGENTS.md'));
      expect(files[1]!.path).toBe(path.join(repo, 'src', 'feature', 'AGENTS.md'));
      expect(files[0]!.content).toContain('kebab-case');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('dedupes across calls via the session-level loadedPaths set', async () => {
    const repo = makeRepo();
    try {
      const file = write(repo, 'pkg/a.ts', 'export {};\n');
      write(repo, 'pkg/AGENTS.md', '# pkg rules');

      const loadedPaths = new Set<string>();
      const first = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [file],
        loadedPaths,
      });
      expect(first).toHaveLength(1);

      const second = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [file],
        loadedPaths,
      });
      expect(second).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns nothing when no nested files exist', async () => {
    const repo = makeRepo();
    try {
      // Root AGENTS.md is eagerly loaded — must NOT be re-injected here.
      write(repo, 'AGENTS.md', '# root rules');
      const file = write(repo, 'lib/a.ts', 'export {};\n');

      const files = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [file],
        loadedPaths: new Set(),
      });

      expect(files).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects trigger paths outside cwd and inside .git / node_modules', async () => {
    const repo = makeRepo();
    const outside = path.resolve(repo, '..', 'outside-agents-md.txt');
    try {
      fs.writeFileSync(outside, 'x', 'utf-8');
      write(repo, '.git/AGENTS.md', '# forged');
      write(repo, 'node_modules/pkg/AGENTS.md', '# forged');

      const files = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [outside, path.join(repo, '.git', 'hooks'), path.join(repo, 'node_modules')],
        loadedPaths: new Set(),
      });

      expect(files).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('injects ancestor-chain conditional rules whose globs match the trigger', async () => {
    const repo = makeRepo();
    try {
      const tsFile = write(repo, 'src/deep/a.ts', 'export {};\n');
      const mdFile = write(repo, 'docs/note.md', 'note\n');
      write(
        repo,
        'AGENTS.md',
        '---\npaths: src/**\n---\n# TS rule\nStrict mode everywhere.',
      );

      const loadedPaths = new Set<string>();

      const forTs = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [tsFile],
        loadedPaths,
      });
      expect(forTs.map((f) => f.path)).toEqual([path.join(repo, 'AGENTS.md')]);
      expect(forTs[0]!.content).toContain('Strict mode');

      // Non-matching trigger does not get the rule…
      const forMd = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [mdFile],
        loadedPaths: new Set(),
      });
      expect(forMd).toHaveLength(0);

      // …and the matching rule is not re-injected for a second TS read.
      const again = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [tsFile],
        loadedPaths,
      });
      expect(again).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('discovers .duya/rules/*.md in nested directories', async () => {
    const repo = makeRepo();
    try {
      const file = write(repo, 'apps/web/a.ts', 'export {};\n');
      write(repo, 'apps/.duya/rules/style.md', 'No barrel files.');

      const files = await collectNestedMemoryFiles({
        cwd: repo,
        triggerPaths: [file],
        loadedPaths: new Set(),
      });

      expect(files.map((f) => f.path)).toEqual([
        path.join(repo, 'apps', '.duya', 'rules', 'style.md'),
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('AgentsMdManager nested memory facade (plan 408b)', () => {
  it('collects delta once per session and renders the envelope', async () => {
    const repo = makeRepo();
    try {
      write(repo, 'AGENTS.md', '# root rules');
      write(repo, 'pkg/AGENTS.md', 'Use barrels sparingly.');
      const file = write(repo, 'pkg/a.ts', 'export {};\n');

      const manager = createAgentsMdManager();
      await manager.refreshForTask(repo);

      const files = await manager.collectNestedMemory([file]);
      expect(files).toHaveLength(1);

      const block = manager.renderNestedMemoryBlock(files);
      // Plan 567 §B: renderNestedMemoryBlock returns the INNER body only —
      // the outer <system-reminder> envelope is applied once by the
      // injection site (renderSystemReminder(inner, 'nested_agents_md')).
      expect(block.startsWith('<system-reminder>')).toBe(false);
      expect(block).toContain('<project_instructions_spec>');
      expect(block).toContain('nested directory');
      expect(block).toContain('Use barrels sparingly.');
      // No eager-load preamble on nested injections.
      expect(block).not.toContain('OVERRIDE any default behavior');

      // Second turn: no delta.
      expect(await manager.collectNestedMemory([file])).toHaveLength(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns empty before initialization and for empty input', async () => {
    const manager = createAgentsMdManager();
    expect(await manager.collectNestedMemory(['/anywhere/x.ts'])).toEqual([]);
    await manager.refreshForTask(process.cwd());
    expect(await manager.collectNestedMemory([])).toEqual([]);
  });
});

describe('extractTriggerPaths', () => {
  it('collects absolute paths from read/edit/write/grep/glob inputs', () => {
    const repo = makeRepo();
    try {
      const paths = extractTriggerPaths(
        [
          { name: 'read', input: { file_path: path.join(repo, 'a.ts') } },
          { name: 'edit', input: { file_path: 'b.ts' } },
          { name: 'grep', input: { pattern: 'x', path: 'src' } },
          { name: 'bash', input: { command: 'ls' } },
          { name: 'read', input: {} },
        ],
        repo,
      );

      expect(paths).toEqual([
        path.join(repo, 'a.ts'),
        path.join(repo, 'b.ts'),
        path.join(repo, 'src'),
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

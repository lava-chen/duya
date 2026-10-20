import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('junction-worktree overlays', () => {
  it('plans every workspace package in both packages and apps overlays', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-junction-overlay-'));
    roots.push(root);
    const primary = join(root, 'primary');
    const worktree = join(root, 'worktree');
    writeFileSync(join(root, 'unused'), '');
    mkdirSync(join(primary, 'packages', 'agent-protocol'), { recursive: true });
    mkdirSync(join(primary, 'apps', 'desktop'), { recursive: true });
    mkdirSync(join(worktree, 'packages', 'agent-protocol'), { recursive: true });
    mkdirSync(join(worktree, 'apps', 'desktop'), { recursive: true });
    writeFileSync(join(primary, 'package.json'), JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }));
    writeFileSync(join(primary, 'packages', 'agent-protocol', 'package.json'), JSON.stringify({ name: '@duya/agent-protocol' }));
    writeFileSync(join(primary, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@duya/desktop' }));
    writeFileSync(join(worktree, 'packages', 'agent-protocol', 'package.json'), JSON.stringify({ name: '@duya/agent-protocol' }));
    writeFileSync(join(worktree, 'apps', 'desktop', 'package.json'), JSON.stringify({ name: '@duya/desktop' }));
    writeFileSync(join(worktree, '.git'), 'gitdir: ignored-by-explicit-primary');

    const output = execFileSync(process.execPath, [
      resolve('scripts/junction-worktree.mjs'), worktree, '--primary', primary, '--dry-run',
    ], { encoding: 'utf8' });

    const normalizedOutput = output.replaceAll('\\', '/');
    expect(normalizedOutput).toContain('[dry-run] created apps/node_modules/@duya/agent-protocol');
    expect(normalizedOutput).toContain('[dry-run] created apps/node_modules/@duya/desktop');
    expect(normalizedOutput).toContain('[dry-run] created packages/node_modules/@duya/agent-protocol');
  });
});

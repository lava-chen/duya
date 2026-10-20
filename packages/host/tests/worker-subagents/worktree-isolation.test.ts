/**
 * `isolation: 'worktree'` against a real git repository — pointed at the
 * implementation production actually runs.
 *
 * ## Why this file had to be written at all
 *
 * `createIsolatedWorktree` existed twice. `packages/agent/src/tool/
 * SubagentTool/worktree.ts` was a byte-for-byte copy except for two imports
 * and the last two lines of `worktreeBaseDir` — and the copy in `packages/
 * agent` was the one with the tests, while production calls the Host one
 * (`worker-subagents/service.ts:434`). So the six cases that existed were
 * green against a module no production path reaches: a real `git worktree`
 * being created, checked and removed 900ms away from the code users run.
 *
 * These are the same six cases, moved to the module that is called. Nothing
 * in the fixture had to change: both copies read `DUYA_APP_DATA_PATH` the
 * same way when `DUYA_DATA_ROOT` is unset, which is what the fixture sets.
 *
 * ## The one case that could only be written HERE
 *
 * The two copies resolve the duya-owned root in opposite orders when BOTH
 * env vars are set, and that difference was untested on both sides:
 *
 *   - Host (`worktree.ts:111`)  `DUYA_APP_DATA_PATH || resolveDataRoot()`
 *   - Agent (`managed-shell/paths.ts:8`) takes `DUYA_APP_DATA_PATH` only when
 *     `DUYA_DATA_ROOT` is unset — so there it is the other way round.
 *
 * So a user who sets `DUYA_DATA_ROOT` to relocate their data and also has
 * `DUYA_APP_DATA_PATH` set gets worktrees under the OLD root while their
 * databases move to the new one. That split is deliberate — `worktree.ts:109`
 * says it keeps "the historical application data override" — so this test
 * records it rather than reporting it, and it can only live here because the
 * dead copy could not exhibit the behaviour.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createIsolatedWorktree,
    slugifyWorktreeName,
    WorktreeError,
} from '../../src/worker-subagents/worktree.js';

/** git invocations for the fixture itself; the module under test spawns its own. */
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Create a throwaway repo under the OS temp dir, returned as a CANONICAL path.
 *
 * `createIsolatedWorktree` derives `repoRoot` from `git rev-parse
 * --show-toplevel`, which reports the fully resolved path. On Windows the temp
 * dir is frequently reached through an 8.3 short name (`C:\Users\RUNNER~1\...`),
 * so the raw `mkdtempSync` result and git's answer are the same directory
 * spelled two ways. Resolve the fixture up front so both sides are canonical.
 */
function makeRepo(): string {
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'duya-wt-repo-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@duya.local');
    git(dir, 'config', 'user.name', 'duya test');
    writeFileSync(path.join(dir, 'README.md'), '# test\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');
    return dir;
}

describe('slugifyWorktreeName', () => {
    it('produces a branch-safe fragment from arbitrary model input', () => {
        expect(slugifyWorktreeName('Fix The Failing Tests!')).toBe('fix-the-failing-tests');
        expect(slugifyWorktreeName('a/b:c*d')).toBe('a-b-c-d');
        expect(slugifyWorktreeName('  --  ')).toBe('task');
        expect(slugifyWorktreeName('')).toBe('task');
    });

    it('caps the length so the generated branch name stays usable', () => {
        expect(slugifyWorktreeName('x'.repeat(200)).length).toBeLessThanOrEqual(32);
    });
});

describe('createIsolatedWorktree (the copy production calls)', () => {
    const duyaRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'duya-wt-root-')));
    const previousDuyaPath = process.env.DUYA_APP_DATA_PATH;
    // Deliberately NOT clearing DUYA_DATA_ROOT here. The suite must not depend
    // on it being absent — see the last case for what happens when it is set.
    process.env.DUYA_APP_DATA_PATH = duyaRoot;

    afterAll(() => {
        if (previousDuyaPath === undefined) delete process.env.DUYA_APP_DATA_PATH;
        else process.env.DUYA_APP_DATA_PATH = previousDuyaPath;
        rmSync(duyaRoot, { recursive: true, force: true });
    });

    it('creates a worktree outside the repository and reports its branch', async () => {
        const repo = makeRepo();
        try {
            const worktree = await createIsolatedWorktree(repo, 'fix tests');

            expect(worktree.repoRoot).toBe(path.resolve(repo));
            expect(worktree.branch).toMatch(/^duya\/subagent\/fix-tests-[0-9a-f]{6}$/);
            // Not inside the user's checkout: this is the whole point.
            expect(path.resolve(worktree.path).startsWith(path.resolve(repo) + path.sep)).toBe(false);
            // Under the duya-owned root.
            expect(path.resolve(worktree.path).startsWith(path.resolve(duyaRoot) + path.sep)).toBe(true);

            // The worktree is a real checkout of the same commit.
            expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
            expect(git(worktree.path, 'branch', '--show-current')).toBe(worktree.branch);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it('refuses a directory that is not inside a git repository', async () => {
        const plain = mkdtempSync(path.join(os.tmpdir(), 'duya-plain-'));
        const previousGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
        // The configured temp root can itself live inside the checkout. Keep Git's
        // upward repository discovery from escaping this fixture so the test still
        // exercises a genuinely non-repository directory under that temp root.
        process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
        try {
            await expect(createIsolatedWorktree(plain, 'x')).rejects.toThrow(WorktreeError);
            await expect(createIsolatedWorktree(plain, 'x')).rejects.toMatchObject({
                code: 'not_a_git_repo',
            });
        } finally {
            if (previousGitCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
            else process.env.GIT_CEILING_DIRECTORIES = previousGitCeiling;
            rmSync(plain, { recursive: true, force: true });
        }
    });

    it('refuses a repository with no HEAD commit', async () => {
        const empty = mkdtempSync(path.join(os.tmpdir(), 'duya-empty-repo-'));
        try {
            git(empty, 'init', '-q', '-b', 'main');
            await expect(createIsolatedWorktree(empty, 'x')).rejects.toMatchObject({ code: 'no_head' });
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it('refuses a dirty working tree instead of half-applying anything', async () => {
        const repo = makeRepo();
        try {
            mkdirSync(path.join(repo, 'src'), { recursive: true });
            writeFileSync(path.join(repo, 'src', 'dirty.ts'), 'export const x = 1;\n');

            await expect(createIsolatedWorktree(repo, 'x')).rejects.toMatchObject({
                code: 'dirty_worktree',
            });
            // No worktree was registered with git.
            expect(git(repo, 'worktree', 'list')).not.toContain('duya/subagent/');
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it('DUYA_APP_DATA_PATH wins over DUYA_DATA_ROOT here — the OPPOSITE of the other copy (D12)', async () => {
        // The only behavioural difference between the two implementations, and
        // the reason this suite is not a copy of the old one.
        //
        // A user who sets DUYA_DATA_ROOT to relocate their data, and who also
        // has DUYA_APP_DATA_PATH set (the legacy override), gets worktrees under
        // DUYA_APP_DATA_PATH while `resolveDatabasePaths()` puts the databases
        // under DUYA_DATA_ROOT — the two halves of "their data" land in different
        // places. `packages/agent`'s copy resolves it the other way round, so a
        // green run of the old suite proved nothing about this.
        const repo = makeRepo();
        const dataRootElsewhere = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'duya-data-root-')));
        const previousDataRoot = process.env.DUYA_DATA_ROOT;
        process.env.DUYA_DATA_ROOT = dataRootElsewhere;
        try {
            const worktree = await createIsolatedWorktree(repo, 'precedence probe');

            expect(
                path.resolve(worktree.path).startsWith(path.resolve(duyaRoot) + path.sep),
                'worktree did not follow DUYA_APP_DATA_PATH when DUYA_DATA_ROOT was also set',
            ).toBe(true);
            expect(
                path.resolve(worktree.path).startsWith(path.resolve(dataRootElsewhere) + path.sep),
                'worktree followed DUYA_DATA_ROOT — that is the OTHER copy\'s behaviour',
            ).toBe(false);
        } finally {
            if (previousDataRoot === undefined) delete process.env.DUYA_DATA_ROOT;
            else process.env.DUYA_DATA_ROOT = previousDataRoot;
            rmSync(dataRootElsewhere, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });
});

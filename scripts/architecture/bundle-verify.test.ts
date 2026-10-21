/**
 * bundle-verify.test.ts — the directions T03's `bundle:verify` has to satisfy.
 *
 * ## Why this gate is judged from git rather than from a rebuild
 *
 * The obvious design is "rebuild and compare bytes", and it was tried first. It
 * does not work: esbuild's minified output for this entry is NOT reproducible.
 * Measured on this tree, two consecutive builds of identical source with
 * identical options produced 5515115 / 5515139 / 5515105 bytes across three
 * runs, diverging inside minified identifier allocation
 * (`var bP=S(()=>{})` vs `var bP=S(()=>{"use strict"})`). A byte comparison
 * against that reports STALE on every run for a bundle that is fresh.
 *
 * So the source of truth is git: find the commit that last wrote
 * `packages/host/bundle/`, read the input list esbuild recorded in
 * `worker-metafile.json`, and ask whether any of those files changed after it.
 *
 * ## The fixtures are real git repositories
 *
 * A judgement about commits cannot be faked with a file tree, so each case builds
 * a throwaway repo in the OS temp directory out of the metafile's input paths,
 * committed once. Every transition is then a real git operation, which is the
 * only way to prove the gate reads history rather than mtime.
 *
 * The repository is built ONCE and shared, with each case starting from a
 * `git reset --hard` of that baseline. Creating 1075 files and committing them
 * takes seconds; doing it eight times took 47s and would dominate `npm test`.
 */

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BUNDLE_DIR, METAFILE, bundleCommit, changedSince, verifyBundle } from './bundle-verify.mjs';

const REPO_ROOT = path.resolve(__dirname, '../..');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * A throwaway git repo holding every FIRST-PARTY metafile input.
 *
 * `node_modules` inputs are skipped: `verifyBundle` filters them out of the
 * judged set, so materialising them would add over a thousand files that no
 * assertion can observe.
 *
 * The filter is the SEGMENT one the implementation uses, not a `node_modules/`
 * prefix. The checked-in metafile records its dependency inputs as ABSOLUTE
 * paths (`E:/Projects/duya/node_modules/...`), which a prefix filter does not
 * match at all — and `path.join` then turns one into an un-creatable
 * directory on Windows, so the fixture could not even be built.
 *
 * `core.autocrlf=false` is set explicitly. On Windows the default is `true`,
 * which rewrites line endings on checkout and makes `git status` report every
 * file as modified the moment anything touches it — a fixture artefact that
 * would turn every "expect fresh" case red for the wrong reason.
 */
function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bundle-test-')).replaceAll('\\', '/');
  const meta = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, METAFILE), 'utf8')) as {
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
  };
  const firstParty = Object.keys(meta.inputs).filter((f) => !f.split('/').includes('node_modules'));
  for (const file of firstParty) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// fixture source\n');
  }
  fs.mkdirSync(path.join(root, BUNDLE_DIR, 'BashTool'), { recursive: true });
  fs.writeFileSync(path.join(root, METAFILE), JSON.stringify(meta));
  fs.writeFileSync(path.join(root, BUNDLE_DIR, 'worker-entry.js'), '// fixture output\n');
  fs.writeFileSync(path.join(root, BUNDLE_DIR, 'BashTool', 'BashWorker.js'), '// fixture output\n');
  git(root, 'init', '-q', '.');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.eol', 'lf');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'bundle-verify test');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'build the worker bundle');
  return root;
}

/** A file the live metafile really lists, used as the edit target. */
const INPUT = 'packages/host/src/run-execution.ts';

/**
 * The denominator the live metafile implies: its first-party input count.
 *
 * It reproduces the implementation's filter — `node_modules` as a PATH SEGMENT,
 * not a prefix — because that is what `verifyBundle` counts. Getting this wrong
 * is not cosmetic: the first version subtracted missing files, then the next one
 * anchored at `^node_modules/` while the implementation had moved to segments,
 * and both times the assertion disagreed with the gate by nineteen inputs.
 *
 * It is derived rather than hardcoded for the same reason the pinning failed
 * before: the literal was 1075, then 1072, then 1053 as the checked-in metafile
 * and the filter both became correct. A number copied off one tree turns a
 * correct answer into a failure on the next.
 */
function liveDenominator(): number {
  const meta = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, METAFILE), 'utf8')) as {
    inputs: Record<string, unknown>;
  };
  return Object.keys(meta.inputs).filter((f) => !f.split('/').includes('node_modules')).length;
}

describe('bundle:verify', () => {
  let root: string;
  /** The baseline commit: the state in which the bundle is fresh. */
  let baseline: string;

  beforeAll(() => {
    root = makeFixture();
    baseline = git(root, 'rev-parse', 'HEAD').trim();
  }, 120_000);

  afterAll(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Back to the baseline commit, working tree clean.
   *
   * Resetting to `HEAD` would be wrong: two cases COMMIT (the "committed edit"
   * and "rebuild alongside" cases), so `HEAD` has moved by the time the next case
   * starts. Resetting to `HEAD` would then leave that commit in place and the
   * following "expect fresh" case would see it as a bundle input change — which
   * is exactly how this fixture first failed.
   */
  beforeEach(() => {
    git(root, 'reset', '--hard', '-q', baseline);
    git(root, 'clean', '-qfd');
  });

  describe('GREEN on a bundle built from the current source', () => {
    it('reports fresh with a denominator, not a bare zero', () => {
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('fresh');
      expect(result.staleInputs).toEqual([]);
      // `0/<n>` where n is the first-party input count the metafile lists.
      expect(result.summary).toBe(`0/${liveDenominator()} bundle inputs changed after the bundle commit`);
      expect(result.detail).toContain('every first-party input is unchanged since');
    });

    it('names the commit the bundle was built at', () => {
      const head = git(root, 'rev-parse', 'HEAD').trim();
      expect(bundleCommit(root)?.sha).toBe(head);
      expect(verifyBundle({ repoRoot: root }).bundleCommit?.sha).toBe(head);
    });

    it('counts both artifacts as present and fresh', () => {
      const result = verifyBundle({ repoRoot: root });
      expect(result.artifacts.map((a) => a.name)).toEqual([
        'worker-entry.js',
        'BashTool/BashWorker.js',
      ]);
      expect(result.artifacts.every((a) => a.present && a.stale === false)).toBe(true);
    });
  });

  describe('RED when a bundle input moves on', () => {
    it('reports an uncommitted edit as a working-tree change, not a committed one', () => {
      // The window this gate exists to close: someone edits a worker source
      // file, runs a test, and the checked-in bundle keeps executing the old
      // code. This is stale the moment the file is saved.
      fs.appendFileSync(path.join(root, INPUT), '// edited\n');
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('stale');
      expect(result.changedWorkingTree).toEqual([INPUT]);
      expect(result.changedCommitted).toEqual([]);
      expect(result.staleInputs).toEqual([INPUT]);
      expect(result.summary).toBe(`1/${liveDenominator()} bundle inputs changed after the bundle commit`);
    });

    it('still reports it after the edit is committed, now as a committed change', () => {
      // Same staleness, different fix: the reader must rebuild before
      // committing, not hunt for a working-tree edit that no longer exists.
      fs.appendFileSync(path.join(root, INPUT), '// edited\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'edit a worker source file');
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('stale');
      expect(result.changedWorkingTree).toEqual([]);
      expect(result.changedCommitted).toEqual([INPUT]);
      expect(result.detail).toContain('1 committed, 0 uncommitted');
    });

    it('goes back GREEN when the rebuild is committed alongside the edit', () => {
      // The complete fix, in the order the repo requires: edit, rebuild, commit
      // both. Without this direction the gate could be red unconditionally.
      fs.appendFileSync(path.join(root, INPUT), '// edited\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'edit a worker source file');
      fs.writeFileSync(path.join(root, BUNDLE_DIR, 'worker-entry.js'), '// rebuilt\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'rebuild the worker bundle');
      expect(verifyBundle({ repoRoot: root }).verdict).toBe('fresh');
    });

    it('reports a deleted input, which only a rebuild fixes', () => {
      fs.rmSync(path.join(root, INPUT));
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'delete a worker source file');
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('stale');
      expect(result.staleInputs).toContain(INPUT);
    });

    it('ignores an edit to a file the bundle never imported', () => {
      // The reason this is not "the packages/host directory was touched": a
      // change to a test, a script, or any module outside the closure does not
      // invalidate the artifact, and a gate that said otherwise would be red
      // constantly.
      fs.writeFileSync(
        path.join(root, 'packages/host/src/__not_a_bundle_input__.ts'),
        'export const nothing = 1;\n',
      );
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'add an unrelated module');
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('fresh');
      expect(result.staleInputs).toEqual([]);
    });

    it('answers about exactly the paths it was given', () => {
      // `changedSince` answers with the paths GIT produced, and its caller
      // intersects them with the metafile's input list. That intersection is done
      // by membership (`paths.filter` was the earlier shape, and it requires the
      // two spellings to agree character-for-character before an input is reported
      // at all — one separator or case difference empties the intersection and
      // STALE becomes GREEN).
      //
      // There is no way to drive that difference from outside on this host: the
      // metafile and git both emit forward slashes, and a `\`-spelled argument dies
      // in the git call itself. What IS observable from outside is the closure-side
      // property the membership shape buys — the answer never invents a path it was
      // not asked about, and never drops one it was.
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bundle-membership-'));
      try {
        fs.mkdirSync(path.join(fixture, 'packages/host/src'), { recursive: true });
        fs.writeFileSync(path.join(fixture, INPUT), '// a\n');
        fs.writeFileSync(path.join(fixture, 'packages/host/src/other.ts'), '// b\n');
        git(fixture, 'init', '-q', '.');
        git(fixture, 'config', 'core.autocrlf', 'false');
        git(fixture, 'config', 'user.email', 'test@example.invalid');
        git(fixture, 'config', 'user.name', 'bundle-verify test');
        git(fixture, 'add', '-A');
        git(fixture, 'commit', '-qm', 'baseline');
        const base = git(fixture, 'rev-parse', 'HEAD').trim();
        fs.appendFileSync(path.join(fixture, INPUT), '// edited\n');
        fs.appendFileSync(path.join(fixture, 'packages/host/src/other.ts'), '// edited\n');

        // Asked about one file: exactly that file comes back, spelled as asked.
        expect(changedSince(base, [INPUT], fixture)).toEqual({
          committed: [],
          workingTree: [INPUT],
        });
        // Asked about a path that is not a file: nothing comes back, not the two
        // that did change (a prefix or substring match would leak them).
        expect(changedSince(base, ['packages/host/src'], fixture)).toEqual({
          committed: [],
          workingTree: [],
        });
        expect(changedSince(base, [], fixture)).toEqual({ committed: [], workingTree: [] });
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    });
  });
});

describe('bundle:verify refuses to guess', () => {
  it('is undetermined, not fresh, when there is no metafile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bundle-none-'));
    try {
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('undetermined');
      expect(result.detail).toContain('has no recorded input set');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is undetermined, not fresh, when the metafile is not JSON', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bundle-badmeta-'));
    try {
      fs.mkdirSync(path.join(root, BUNDLE_DIR), { recursive: true });
      fs.writeFileSync(path.join(root, METAFILE), '{ not json');
      const result = verifyBundle({ repoRoot: root });
      expect(result.verdict).toBe('undetermined');
      expect(result.detail).toContain('not valid JSON');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('is undetermined, not fresh, when git cannot name the bundle commit', () => {
    // A directory holding a metafile but not a git checkout: `bundleCommit` must
    // return null and the caller must not read that as "nothing changed".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bundle-nogit-'));
    try {
      fs.mkdirSync(path.join(root, BUNDLE_DIR), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, METAFILE), path.join(root, METAFILE));
      expect(bundleCommit(root)).toBeNull();
      expect(verifyBundle({ repoRoot: root }).verdict).toBe('undetermined');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null from changedSince when git cannot answer', () => {
    expect(
      changedSince(
        '0000000000000000000000000000000000000000',
        ['packages/host/src/x.ts'],
        path.join(os.tmpdir(), 'definitely-not-a-repo'),
      ),
    ).toBeNull();
  });
});

describe('bundle:verify on the live tree', () => {
  it('finds the bundle commit and reports a denominator bounded by the metafile', () => {
    // At the time T03 was written the live tree is STALE — that is the fact the
    // card exists to establish, and it is recorded in the plan rather than
    // asserted here, because the next person to rebuild the bundle will make
    // this green and must not be forced to edit a test to say so.
    const commit = bundleCommit(REPO_ROOT);
    expect(commit).not.toBeNull();
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/);
    const result = verifyBundle();
    expect(['fresh', 'stale']).toContain(result.verdict);
    // The denominator is the metafile's first-party input count: a `0/0` would
    // mean the lookup collapsed, and every verdict above would be vacuous.
    expect(result.summary).toBe(
      `${result.staleInputs.length}/${liveDenominator()} bundle inputs changed after the bundle commit`,
    );
    if (result.verdict === 'stale') {
      expect(result.staleInputs.length).toBeGreaterThan(0);
    } else {
      expect(result.staleInputs).toEqual([]);
    }
  });

  it('filters node_modules out of the judged set', () => {
    // A dependency bump changes `node_modules/**` inputs and has its own gate
    // (the lockfile). Counting them here would make this permanently red for a
    // clean install after any version change.
    const result = verifyBundle();
    for (const file of result.staleInputs) {
      expect(file.split('/')).not.toContain('node_modules');
    }
  });

  it('filters a nested node_modules too, not only the hoisted one', () => {
    // `^node_modules/` matched the hoisted copy and missed a workspace package's
    // own `node_modules/` (e.g. `packages/capabilities/node_modules/diff/...`).
    // Those paths are absent in a fresh worktree — dependencies are not
    // installed there — so they arrived as DELETED inputs and made the verdict
    // report a stale bundle for a dependency that never moved. Measured on this
    // tree: twenty such files, which took a 24-input verdict to 43.
    const metafile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, METAFILE), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    const nested = Object.keys(metafile.inputs).filter((f) => f.split('/').includes('node_modules'));
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.some((f) => !f.startsWith('node_modules/'))).toBe(true);
    const result = verifyBundle();
    for (const file of result.staleInputs) {
      expect(file.split('/')).not.toContain('node_modules');
    }
  });
});

#!/usr/bin/env node
/**
 * bundle-verify.mjs — plan 610 §1.2 G8 / T03.
 *
 * > G8: `packages/host/bundle/*` is tracked, and it is older than the source it
 * > was built from.
 *
 * ## The problem this answers
 *
 * The worker bundle is a build artifact that is COMMITTED. That is unusual and
 * deliberate: the packaged app ships `packages/host/bundle/` as
 * `resources/harness-bundle/`, and the CLI spawns it straight out of a checkout
 * with no build step. Not committing it would mean every consumer has to run
 * `build:packages` before the app can start — which is how a stale bundle turns
 * into a support ticket instead of a red check.
 *
 * A committed artifact has exactly one failure mode, and this repo has it: the
 * artifact drifts from its source. Someone edits `packages/host/src/**`, runs a
 * test, never rebuilds, and the checked-in bundle keeps executing last week's
 * code. Nothing goes red — the artifact is byte-perfect, it is just perfect for
 * a different tree.
 *
 * ## How "stale" is decided, and why not by rebuilding
 *
 * The obvious judgement is "rebuild and compare bytes". It was tried first and
 * it does not work here — not because of cost, but because esbuild's minified
 * output is NOT reproducible for this entry. Measured on this tree: two
 * consecutive builds of the identical source, same options, produce different
 * bytes and different lengths (5515115 / 5515139 / 5515105 across three runs).
 * The divergence is in minified identifier allocation —
 * `var bP=S(()=>{})` in one render, `var bP=S(()=>{"use strict"})` in the next —
 * which is esbuild's name assignment being sensitive to module traversal order
 * rather than to the source. A byte comparison against a nondeterministic build
 * reports STALE on every run, for a bundle that is fresh. The first version of
 * this script did exactly that and reported `UNDETERMINED` everywhere, which is
 * at least honest but useless.
 *
 * So the judgement is made from GIT, which is deterministic by construction:
 *
 *   1. `packages/host/bundle/` is tracked. Find the commit that last wrote it —
 *      that is the commit the checked-in bundle belongs to.
 *   2. Read `worker-metafile.json`, which esbuild wrote during that build. Its
 *      `inputs` keys are the exact set of files the bundle was built from (2200
 *      of them on this tree, first-party and `node_modules` both).
 *   3. Ask git whether any of THOSE files changed after that commit.
 *
 * The third step is what makes this a real judgement rather than "the directory
 * was touched": a commit that only edits `packages/host/src/__tests__/**`
 * changes nothing in the bundle, and this script stays green. Measured today:
 * 27 of the 2200 inputs changed after the bundle commit, so G8 is RED for a
 * reason and not for noise.
 *
 * ## The halves it checks, and the one it cannot
 *
 *   - STRUCTURAL — every metafile input still exists on disk. A deleted source
 *     file means the bundle was built from a tree that no longer exists.
 *   - CONTENT — no metafile input was modified after the bundle commit, counting
 *     both committed history AND the current working tree (an uncommitted edit
 *     to `run-execution.ts` makes the bundle stale the moment it is saved).
 *   - COPIES — the two trees the build copies instead of compiling (the prompt
 *     assets and the bundled skills) carry the same files as their source.
 *     These never reach `worker-metafile.json`, because esbuild never loads
 *     them, so the two halves above said nothing about them: editing a `.hbs`
 *     and not rebuilding left the checked-in bundle serving the old prompt
 *     while this gate stayed green.
 *
 * Not checked: a NEWLY added source file that the bundle does not import. It is
 * invisible by construction — the bundle does not know about files it never
 * saw. That is the gap a rebuild would close and this cannot; it is named here
 * so the gate is not read as "the bundle contains everything the source has".
 *
 * ## Why the copies are judged by comparison, not by git history
 *
 * The git judgement above answers "did the source move after the bundle was
 * built?", which is the right question for compiled output. For a copied tree
 * the direct question is available and better: "does the committed mirror
 * carry the current source?". The mirror is compared file by file, so a
 * rebuild that was never committed, a copy step that skipped a file, and a
 * source file deleted out from under the bundle are all caught, and none of
 * them depends on how the commits happen to be ordered.
 *
 * Line endings are normalized before comparing. A Windows checkout hands the
 * contributor CRLF while the index holds LF; that difference is invisible to
 * every consumer of these files and would otherwise make the gate red for
 * everyone.
 *
 * ## Why git history is a legitimate source of truth here
 *
 * It assumes the bundle and the source it was built from ship in the SAME
 * commit, which is what `npm run bundle:worker` + "commit the bundle" already
 * means in this repo. If someone commits only the bundle, the judgement still
 * holds (nothing in the closure changed after it, so it is fresh by this
 * measure) and only a rebuild-first workflow would catch a byte-level
 * difference — which, per the nondeterminism above, cannot be caught by
 * comparison anyway.
 *
 * ## Exit codes
 *
 *   0  fresh         — no bundle input changed after the bundle commit, and
 *                      every copied tree matches its source
 *   1  stale         — at least one did; the report names them and the rebuild
 *   2  undetermined  — git could not answer (shallow clone, missing metafile,
 *                      not a git checkout). Never reported as clean.
 *
 * `2` is separate from `1` on purpose: "the bundle is old" and "I could not
 * tell" call for different fixes, and collapsing them sends the reader hunting
 * for a source edit that may not exist.
 *
 * ## Usage
 *
 *   node scripts/architecture/bundle-verify.mjs          verify
 *   node scripts/architecture/bundle-verify.mjs --json   machine-readable verdict
 *   node scripts/architecture/bundle-verify.mjs --quiet  exit code only
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/** The tracked bundle directory and the metafile esbuild wrote into it. */
export const BUNDLE_DIR = 'packages/host/bundle';
export const METAFILE = `${BUNDLE_DIR}/worker-metafile.json`;

/**
 * The artifacts whose inputs define the bundle's source set.
 *
 * `worker-entry.js` is the only esbuild output with a metafile; `BashTool/
 * BashWorker.js` is a second entry built without `metafile: true`, so its own
 * input list is not recorded. Its source (`packages/host/src/managed-shell/**`)
 * is covered indirectly whenever those files are also reachable from the entry,
 * but that is NOT guaranteed — so the artifact is listed and its freshness is
 * judged by the same "changed after the bundle commit" rule applied to its
 * entry file, which is the one file this script can name.
 */
export const ARTIFACTS = [
  {
    name: 'worker-entry.js',
    output: 'worker-entry.js',
    entry: 'packages/cli/src/agent-worker-entry.ts',
    metafileBacked: true,
  },
  {
    name: 'BashTool/BashWorker.js',
    output: path.join('BashTool', 'BashWorker.js'),
    entry: 'packages/host/src/managed-shell/BashWorker.ts',
    metafileBacked: false,
  },
];

/**
 * Directories the build copies into the bundle verbatim, each with the source
 * it mirrors.
 *
 * `worker-metafile.json` records what esbuild LOADED — the TypeScript closure.
 * These two trees are copied by `fs.cpSync` and never reach the metafile, so
 * nothing judged the copies: editing a `.hbs` or a SKILL.md without rebuilding
 * left the checked-in bundle carrying the old prompt while this gate stayed
 * green. The eval fixture and the Host integration test both run the
 * PRODUCTION bundle straight out of the checkout, so the stale copy was the
 * thing under test.
 *
 * They are compared against the source directly rather than through git. They
 * are small text trees, and the question is the direct one — "does the
 * committed bundle carry the current source?" — which does not depend on
 * commit ordering the way the git judgement does.
 */
export const COPY_TREES = [
  {
    name: 'prompt-assets',
    source: 'packages/host/src/worker-prompts/assets',
    mirror: 'packages/host/bundle/assets',
  },
  {
    name: 'bundled-skills',
    source: 'packages/host/skills',
    mirror: 'packages/host/bundle/skills',
  },
];

/** Run git in the repo root, returning stdout, or null when git cannot answer. */
function git(args, repoRoot) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * The commit that last wrote anything under `packages/host/bundle/`.
 *
 * `--` bounds the pathspec so a filename named `HEAD` cannot be mistaken for a
 * revision, and `-1` keeps the answer to one commit because everything after it
 * is a later answer to a different question.
 */
export function bundleCommit(repoRoot = REPO_ROOT) {
  const out = git(['log', '-1', '--format=%H|%cI|%s', '--', BUNDLE_DIR], repoRoot);
  if (out === null) return null;
  const line = out.trim();
  if (line.length === 0) return null;
  const [sha, iso, ...subject] = line.split('|');
  return { sha, iso, subject: subject.join('|') };
}

/**
 * Files among `paths` that differ from the bundle's own source, split by origin.
 *
 * The two halves are reported separately because they need different actions and
 * a merged list sends the reader to the wrong place:
 *
 *   - `committed` — changed in history after `commit`. The bundle was built from
 *     an older tree; rebuild and commit.
 *   - `workingTree` — modified but not committed yet. The bundle is stale the
 *     moment the edit is saved, and rebuilding now would produce a bundle that
 *     does not match any commit. The fix is to finish the edit, then rebuild as
 *     part of that same change.
 *
 * Returns null when git could not answer, which the caller reports as
 * `undetermined` — never as clean.
 */
export function changedSince(commit, paths, repoRoot = REPO_ROOT) {
  if (paths.length === 0) return { committed: [], workingTree: [] };
  // Every path git hands back is compared against the metafile's input set with
  // `Set.has`, i.e. by membership. That is the whole point of a Set here: the
  // alternative — filtering `paths` by membership in the git result — silently
  // drops an input whose spelling differs from git's (a `\` from a Windows-side
  // caller, a differently-cased drive letter), and an empty intersection reads as
  // "nothing changed" on a bundle that is stale.
  const inputs = new Set(paths);
  const isInput = (file) => inputs.has(file);
  // One call per top-level directory rather than one call with 2200 paths: the
  // latter overflows the Windows command line (measured: E2BIG past ~2000 args).
  const roots = [...new Set(paths.map((p) => p.split('/').slice(0, 2).join('/')))];
  const committed = new Set();
  for (const root of roots) {
    // `--relative` keeps paths repo-relative regardless of `cwd`.
    const out = git(
      ['log', '--name-only', '--pretty=format:', '--relative', `${commit}..HEAD`, '--', root],
      repoRoot,
    );
    if (out === null) return null;
    for (const line of out.split('\n')) {
      const file = line.trim();
      if (file.length > 0) committed.add(file);
    }
  }
  // `git status` has NO `--relative` flag (that is `git log`/`git diff`); it
  // already reports repo-relative paths whenever `cwd` is the worktree root,
  // which the `cwd: repoRoot` in `git()` guarantees.
  //
  // `--untracked-files=no` is deliberate: an untracked file cannot be a bundle
  // input, because the bundle was built before it existed. Counting it would
  // make this red for every scratch file in the tree.
  const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...roots], repoRoot);
  if (dirty === null) return null;
  const workingTree = new Set();
  for (const line of dirty.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Porcelain v1: two status columns, then a space, then the path. A rename
    // prints `orig -> new`, and the NEW path is the one on disk, so the arrow
    // form is split rather than trimmed.
    const raw = trimmed.slice(2).trim();
    const file = raw.includes(' -> ') ? raw.split(' -> ')[1].trim() : raw;
    if (file.length > 0) workingTree.add(file);
  }
  return {
    committed: [...committed].filter(isInput),
    workingTree: [...workingTree].filter(isInput),
  };
}

/**
 * Files under `dir` that git considers part of the source: tracked, plus
 * untracked-but-not-ignored.
 *
 * The build copies the whole directory, so a NEW file in the source tree is a
 * file the mirror must carry — that is why untracked files count here, unlike
 * the metafile inputs, where an untracked file cannot be an input because the
 * bundle was built before it existed. Ignored files are excluded on purpose:
 * they are not source, and a scratch file in a source tree must not turn the
 * gate red.
 *
 * Returns null when git cannot answer.
 */
function listSourceFiles(dir, repoRoot) {
  // `core.quotepath=false`: git otherwise escapes a path holding non-ASCII
  // characters into a quoted form, and the escaped string is not a path this
  // script can open.
  const out = git(
    ['-c', 'core.quotepath=false', 'ls-files', '-c', '-o', '--exclude-standard', '--', dir],
    repoRoot,
  );
  if (out === null) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Every file under `dir` on disk, relative to it, with forward slashes.
 */
function walkFiles(dir, repoRoot) {
  const root = path.join(repoRoot, dir);
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, '');
  return out;
}

/**
 * Whether two files hold the same content, ignoring line-ending differences.
 *
 * The comparison is on bytes first and falls back to a line-ending-normalized
 * text comparison, because a checkout hands a Windows contributor CRLF while
 * the artifact in the index holds LF. Judging that as a difference would make
 * the gate red for every contributor, over a difference no prompt renderer
 * sees.
 */
function sameContent(a, b) {
  const left = fs.readFileSync(a);
  const right = fs.readFileSync(b);
  if (left.equals(right)) return true;
  // A NUL byte means binary: the lossy UTF-8 decode below would collapse
  // differences it cannot represent, so binary files are compared on bytes
  // only.
  if (left.includes(0) || right.includes(0)) return false;
  return (
    left.toString('utf8').replace(/\r\n/g, '\n') === right.toString('utf8').replace(/\r\n/g, '\n')
  );
}

/**
 * Compare one copy tree's source against the mirror the build produced.
 *
 * Three ways to be out of date, and all three are fixed by the same rebuild:
 *
 *   - `missing` — the source has a file the mirror does not. Either the copy
 *     step skipped it, or the file was added after the last rebuild.
 *   - `differing` — the mirror carries a different version of a source file.
 *     The prompt or the skill changed and the bundle was not rebuilt.
 *   - `extra` — the mirror carries a file the source no longer has. The source
 *     file was deleted and the bundle still ships the old copy.
 */
function compareCopyTree(tree, repoRoot) {
  const sourceFiles = listSourceFiles(tree.source, repoRoot);
  if (sourceFiles === null) {
    return {
      name: tree.name,
      source: tree.source,
      mirror: tree.mirror,
      stale: true,
      fileCount: 0,
      missing: [],
      differing: [],
      extra: [],
      reason: 'git could not list the source tree',
    };
  }

  const missing = [];
  const differing = [];
  for (const file of sourceFiles) {
    const sourcePath = path.join(repoRoot, ...file.split('/'));
    // A file the index still lists but the working tree no longer holds was
    // deleted without being staged. It is not a source file any more, and the
    // mirror still carrying it is reported as `extra` below.
    if (!fs.existsSync(sourcePath)) continue;
    const rel = file.slice(tree.source.length + 1);
    const mirrorPath = path.join(repoRoot, tree.mirror, ...rel.split('/'));
    if (!fs.existsSync(mirrorPath)) {
      missing.push(rel);
      continue;
    }
    if (!sameContent(sourcePath, mirrorPath)) {
      differing.push(rel);
    }
  }

  // A mirror file the source no longer has is matched against the source ON
  // DISK, not against its tracked file list: an ignored file sitting in the
  // source tree is copied by the build, so its presence in the mirror is
  // correct and must not be reported as a leftover.
  const onDisk = new Set(walkFiles(tree.source, repoRoot));
  const extra = walkFiles(tree.mirror, repoRoot).filter((rel) => !onDisk.has(rel));

  return {
    name: tree.name,
    source: tree.source,
    mirror: tree.mirror,
    stale: missing.length > 0 || differing.length > 0 || extra.length > 0,
    fileCount: sourceFiles.length,
    missing: missing.sort(),
    differing: differing.sort(),
    extra: extra.sort(),
    reason: null,
  };
}

/**
 * Verify the checked-in bundle against the source it should be built from.
 *
 * Returns `{ verdict, bundleCommit, artifacts, staleInputs, copyTrees, summary,
 * copySummary, detail }` where `verdict` is `'fresh' | 'stale' | 'undetermined'`.
 */
export function verifyBundle(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const metafilePath = path.join(repoRoot, METAFILE);

  if (!fs.existsSync(metafilePath)) {
    return {
      verdict: 'undetermined',
      bundleCommit: null,
      artifacts: [],
      staleInputs: [],
      copyTrees: [],
      summary: '0/0 artifacts checked',
      detail: `${METAFILE} does not exist — the bundle has no recorded input set`,
    };
  }

  let metafile;
  try {
    metafile = JSON.parse(fs.readFileSync(metafilePath, 'utf8'));
  } catch (error) {
    return {
      verdict: 'undetermined',
      bundleCommit: null,
      artifacts: [],
      staleInputs: [],
      copyTrees: [],
      summary: '0/0 artifacts checked',
      detail: `${METAFILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // `node_modules` anywhere in the path, not just at the root: a workspace
  // package's own `node_modules` (a nested or version-pinned dependency) is a
  // dependency too, and it is ABSENT in a fresh worktree — which this would
  // otherwise report as a deleted input and a stale bundle. Anchoring the filter
  // at `^node_modules/` was that bug: it matched the hoisted copy and missed
  // `packages/capabilities/node_modules/diff/...`, twenty files of noise.
  const inputs = Object.keys(metafile.inputs ?? {}).filter(
    (f) => !f.split('/').includes('node_modules'),
  );
  const commit = bundleCommit(repoRoot);
  if (commit === null) {
    return {
      verdict: 'undetermined',
      bundleCommit: null,
      artifacts: [],
      staleInputs: [],
      copyTrees: [],
      summary: `0/${inputs.length} inputs checked`,
      detail: 'git could not name the commit that last wrote the bundle (shallow clone, or not a checkout)',
    };
  }

  // STRUCTURAL: a metafile input that no longer exists means the bundle was
  // built from a tree that is gone. Reported as stale inputs with a reason,
  // because the fix is the same as a content change: rebuild.
  const missing = inputs.filter((f) => !fs.existsSync(path.join(repoRoot, f)));

  // CONTENT: only the first-party half. `node_modules` inputs are filtered out
  // above on purpose — a dependency bump that changes them is a lockfile event
  // with its own gate, and treating every `npm install` as bundle staleness
  // would make this permanently red on a clean install after a version change.
  const changed = changedSince(commit.sha, inputs, repoRoot);
  if (changed === null) {
    return {
      verdict: 'undetermined',
      bundleCommit: commit,
      artifacts: [],
      staleInputs: [],
      changedCommitted: [],
      changedWorkingTree: [],
      copyTrees: [],
      summary: `0/${inputs.length} inputs checked`,
      detail: `git could not list changes after ${commit.sha.slice(0, 8)}`,
    };
  }

  const staleInputs = [
    ...new Set([...changed.committed, ...changed.workingTree, ...missing]),
  ].sort();
  const artifacts = ARTIFACTS.map((artifact) => {
    const artifactPath = path.join(repoRoot, BUNDLE_DIR, artifact.output);
    const present = fs.existsSync(artifactPath);
    // An artifact is stale when ANY input of the shared metafile changed. The
    // metafile does not attribute inputs to outputs precisely enough to do
    // better, and over-reporting one artifact is the safe direction: the fix is
    // the same rebuild either way.
    return {
      name: artifact.name,
      present,
      bytes: present ? fs.statSync(artifactPath).size : null,
      stale: !present || staleInputs.length > 0,
    };
  });

  // The two trees the build copies rather than compiles. They are judged
  // against their source directly, so they are NOT folded into `staleInputs`:
  // that list is the metafile's input set, and its denominator is the
  // metafile's input count. Mixing the two would make the summary lie about
  // what it counted.
  const copyTrees = COPY_TREES.map((tree) => compareCopyTree(tree, repoRoot));
  const staleCopies = copyTrees.filter((tree) => tree.stale);

  const summary = `${staleInputs.length}/${inputs.length} bundle inputs changed after the bundle commit`;
  const copySummary = `${COPY_TREES.length - staleCopies.length}/${COPY_TREES.length} copy trees match their source`;
  if (staleInputs.length === 0 && staleCopies.length === 0) {
    return {
      verdict: 'fresh',
      bundleCommit: commit,
      artifacts,
      staleInputs,
      copyTrees,
      changedCommitted: [],
      changedWorkingTree: [],
      summary,
      copySummary,
      detail: `every first-party input is unchanged since ${commit.sha.slice(0, 8)} (${commit.iso})`,
    };
  }
  return {
    verdict: 'stale',
    bundleCommit: commit,
    artifacts,
    staleInputs,
    copyTrees,
    changedCommitted: [...changed.committed].sort(),
    changedWorkingTree: [...changed.workingTree].sort(),
    summary,
    copySummary,
    detail:
      `${staleInputs.length} input(s) changed after ${commit.sha.slice(0, 8)} (${commit.iso}, "${commit.subject}")` +
      ` — ${changed.committed.length} committed, ${changed.workingTree.length} uncommitted` +
      (missing.length > 0 ? `, ${missing.length} deleted` : '') +
      (staleCopies.length > 0 ? `; ${staleCopies.length} copy tree(s) out of date` : ''),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  const quiet = process.argv.includes('--quiet');
  const result = verifyBundle();

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!quiet) {
    if (result.bundleCommit) {
      const c = result.bundleCommit;
      process.stdout.write(`bundle-verify  bundle commit  ${c.sha.slice(0, 8)} (${c.iso}) ${c.subject}\n`);
    }
    for (const artifact of result.artifacts) {
      process.stdout.write(
        `bundle-verify  ${artifact.stale ? 'STALE' : 'ok   '}  ${artifact.name}` +
          `${artifact.bytes === null ? ' (missing)' : ` (${artifact.bytes} B)`}\n`,
      );
    }
    for (const tree of result.copyTrees ?? []) {
      process.stdout.write(
        `bundle-verify  ${tree.stale ? 'STALE' : 'ok   '}  copy tree ${tree.name} (${tree.fileCount} files)\n`,
      );
    }
    const cap = 12;
    const section = (title, files) => {
      if (files.length === 0) return;
      process.stdout.write(`\n  ${title} (${files.length}):\n`);
      for (const file of files.slice(0, cap)) process.stdout.write(`    ${file}\n`);
      if (files.length > cap) {
        process.stdout.write(`    ... and ${files.length - cap} more (--json for all)\n`);
      }
    };
    if (result.staleInputs.length > 0) {
      section('changed in history after the bundle commit', result.changedCommitted ?? []);
      section('modified in the working tree, not committed', result.changedWorkingTree ?? []);
    }
    for (const tree of result.copyTrees ?? []) {
      if (!tree.stale) continue;
      if (tree.reason) {
        process.stdout.write(`\n  copy tree ${tree.name} could not be judged: ${tree.reason}\n`);
        continue;
      }
      section(`copy tree ${tree.name}: the mirror differs from ${tree.source}`, [
        ...tree.missing.map((file) => `missing from the mirror: ${file}`),
        ...tree.differing.map((file) => `differs: ${file}`),
        ...tree.extra.map((file) => `only in the mirror: ${file}`),
      ]);
    }
    if (result.verdict === 'stale') {
      process.stdout.write(
        '\nThe checked-in worker bundle was built from an older source tree.\n' +
          'Rebuild it and commit the result in the same change:\n\n' +
          '    npm run bundle:worker\n' +
          '    git add packages/host/bundle\n',
      );
    } else if (result.verdict === 'undetermined') {
      process.stdout.write(
        '\nCould not decide whether the bundle is fresh. This is NOT a stale bundle\n' +
          'and NOT a clean one — the comparison itself did not run to completion.\n',
      );
    }
    process.stdout.write(
      `bundle-verify  ${result.verdict.toUpperCase()}  ${result.summary}` +
        `${result.copySummary ? `; ${result.copySummary}` : ''} — ${result.detail}\n`,
    );
  }

  process.exit(result.verdict === 'fresh' ? 0 : result.verdict === 'stale' ? 1 : 2);
}

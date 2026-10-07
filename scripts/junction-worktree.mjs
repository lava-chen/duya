#!/usr/bin/env node
/**
 * junction-worktree.mjs — link a git worktree to the primary checkout so that
 * `tsc` / `vitest` / `npm run -w` resolve EXTERNAL dependencies from the primary
 * but resolve `@duya/*` WORKSPACE PACKAGES from the worktree itself.
 *
 * WHY THIS FILE EXISTS (the stale-`dist` leak)
 *
 * `scripts/junction-worktree.bat` and `scripts/junction-workspace-pkgs.bat` link a
 * worktree's `node_modules` to the primary's. That is correct for third-party
 * dependencies and catastrophic for workspace packages, because
 * `node_modules/@duya/<name>` is itself a junction to the PRIMARY checkout's
 * `packages/<name>`:
 *
 *   <worktree>/node_modules                      (junction) -> <primary>/node_modules
 *   <worktree>/node_modules/@duya/agent-runtime  (junction) -> <primary>/packages/agent-runtime
 *   <worktree>/packages/agent-runtime/dist       (real dir, built from WORKTREE source)
 *
 * So `import ... from '@duya/agent-runtime'` inside the worktree resolves to
 * `<primary>/packages/agent-runtime/dist/*.d.ts` — the primary's build output,
 * which was compiled from whatever source the primary last had checked out.
 * The worktree's own correctly-built `dist` is never read by anyone.
 *
 * Two worktrees on different branches then typecheck against the SAME primary
 * `dist`. Exactly one of them can be self-consistent; the other fails with
 * errors that reference symbols that do not exist in its own source (observed:
 * `TS2741: Property 'modeExit' is missing ... but required in type
 * 'RunEnginePorts'`, where `ModeExitPort` exists on the flip branch's source but
 * nowhere on master's). Worse, the surviving worktree passes only by luck —
 * it is validating its source against another branch's declarations.
 *
 * THE FIX
 *
 * Node and TypeScript both resolve `node_modules` by walking UP from the
 * importing file, stopping at the first directory containing the package. So a
 * real overlay directory at `<worktree>/packages/node_modules/@duya/<name>` —
 * checked BEFORE `<worktree>/node_modules` — makes the worktree's own packages
 * win, for every file under `packages/`. The same overlay under
 * `<worktree>/apps/node_modules` covers `apps/desktop`.
 *
 * This is ~14 junctions (a few KB) instead of a second full `node_modules`
 * copy (multiple GB per worktree, on a disk that has ~3.5 GB free).
 *
 * It is also strictly worktree-local: every link is created INSIDE the worktree
 * and points AT the worktree (overlay) or AT the primary (external deps). No
 * link is created inside the primary, so no other worktree and not the primary
 * can observe or be affected by this script. `npm install` is deliberately NOT
 * used — installing here would write through the `<worktree>/node_modules`
 * junction and rewrite the PRIMARY's `@duya/*` links, which is the corruption
 * this script exists to avoid.
 *
 * USAGE
 *
 *   node scripts/junction-worktree.mjs <worktree-path> [--dry-run] [--primary <root>]
 *
 * The primary root is derived from the worktree's own `.git` pointer file
 * (`gitdir: <primary>/.git/worktrees/<name>`) rather than from this script's
 * location, because this script is normally run FROM the worktree — deriving it
 * from `__dirname` would resolve to the worktree and link it onto itself.
 * `--primary` overrides the derivation.
 *
 * Idempotent: existing links are reported and left alone. Never removes
 * anything.
 *
 * Supersedes the hardcoded single-worktree `junction-worktree.bat` and
 * `junction-workspace-pkgs.bat`, which are kept only for reference.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const worktreeArg = args.find((a) => !a.startsWith('--'));

if (!worktreeArg) {
  process.stderr.write(
    'usage: node scripts/junction-worktree.mjs <worktree-path> [--dry-run] [--primary <root>]\n',
  );
  process.exit(2);
}

const primaryFlagIndex = args.indexOf('--primary');
const primaryFlag =
  primaryFlagIndex === -1 ? undefined : args[primaryFlagIndex + 1];

const worktreeRoot = resolve(worktreeArg);

/**
 * Derive the primary checkout root from a worktree's `.git` entry.
 *
 * A linked worktree has a `.git` FILE reading `gitdir: <primary>/.git/worktrees/<name>`.
 * A primary checkout has a `.git` DIRECTORY and is its own primary.
 */
function derivePrimaryRoot(root) {
  const gitPath = join(root, '.git');
  if (!existsSync(gitPath)) return undefined;
  if (statSync(gitPath).isDirectory()) return root; // primary checkout

  const pointer = readFileSync(gitPath, 'utf8').trim();
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;

  // <primary>/.git/worktrees/<name> -> <primary>
  const gitDir = resolve(root, match[1].trim());
  return dirname(dirname(dirname(gitDir)));
}

const primaryRoot = primaryFlag
  ? resolve(primaryFlag)
  : (derivePrimaryRoot(worktreeRoot) ?? resolve(scriptDir, '..'));

/**
 * Read the workspace package directories declared by the primary's
 * `package.json`. Only the `dir/*` glob form is supported, which is all this
 * repo uses (`["packages/*", "apps/*"]`).
 */
function workspacePackageDirs(root) {
  const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const globs = Array.isArray(pkgJson.workspaces)
    ? pkgJson.workspaces
    : (pkgJson.workspaces?.packages ?? []);

  const dirs = [];
  for (const glob of globs) {
    const match = /^([^*]+)\/\*$/.exec(glob);
    if (!match) {
      process.stderr.write(
        `[junction-worktree] unsupported workspaces glob, skipped: ${glob}\n`,
      );
      continue;
    }
    const parent = join(root, match[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') continue;
      const dir = join(parent, entry.name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      dirs.push(dir);
    }
  }
  return dirs;
}

const isWindows = process.platform === 'win32';
const linkType = isWindows ? 'junction' : 'dir';

const created = [];
const skipped = [];

function link(target, linkPath) {
  if (existsSync(linkPath) || isJunction(linkPath)) {
    skipped.push(linkPath);
    return;
  }
  if (!existsSync(target)) return;
  if (dryRun) {
    created.push(linkPath);
    return;
  }
  // Windows junctions require the containing directory to exist first.
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, linkType);
  created.push(linkPath);
}

function isJunction(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// --- 0. sanity -------------------------------------------------------------

if (!existsSync(worktreeRoot)) {
  process.stderr.write(`[junction-worktree] no such worktree: ${worktreeRoot}\n`);
  process.exit(2);
}
if (worktreeRoot === primaryRoot) {
  process.stderr.write(
    '[junction-worktree] refusing to link the primary checkout onto itself\n',
  );
  process.exit(2);
}
if (!existsSync(join(worktreeRoot, '.git'))) {
  process.stderr.write(
    `[junction-worktree] not a git worktree (no .git): ${worktreeRoot}\n`,
  );
  process.exit(2);
}

const pkgs = workspacePackageDirs(primaryRoot).map((dir) => ({
  dir,
  rel: relative(primaryRoot, dir),
  name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name,
}));

// --- 1. shared third-party dependencies ------------------------------------
// `<worktree>/node_modules` -> `<primary>/node_modules`. Everything that is NOT
// a `@duya/*` workspace package resolves through this link.

link(join(primaryRoot, 'node_modules'), join(worktreeRoot, 'node_modules'));

// Per-package third-party deps, mirroring junction-workspace-pkgs.bat.

for (const pkg of pkgs) {
  const target = join(primaryRoot, pkg.rel, 'node_modules');
  if (!existsSync(target)) continue;
  link(target, join(worktreeRoot, pkg.rel, 'node_modules'));
}

// --- 2. the fix: own-package overlay ---------------------------------------
// Real directories under the worktree, checked by Node/TS BEFORE the shared
// `<worktree>/node_modules`, so `@duya/*` resolves to THIS worktree's packages.

for (const pkg of pkgs) {
  if (!pkg.name) continue;
  const scopeParent = dirname(pkg.name); // '@duya'
  if (!scopeParent) continue;
  const pkgDirInWorktree = join(worktreeRoot, pkg.rel);

  // One overlay per top-level workspace parent that contains importers:
  // `packages/` covers every package, `apps/` covers apps/desktop.
  const parentRel = pkg.rel.split(/[\\/]/)[0];
  const overlayScope = join(worktreeRoot, parentRel, 'node_modules', scopeParent);

  link(pkgDirInWorktree, join(overlayScope, pkg.name.slice(scopeParent.length + 1)));
}

// --- 3. report -------------------------------------------------------------

const prefix = dryRun ? '[dry-run] ' : '';
process.stdout.write(
  `[junction-worktree] primary  : ${primaryRoot}\n` +
    `[junction-worktree] worktree : ${worktreeRoot}\n` +
    `[junction-worktree] packages: ${pkgs.length}\n`,
);

for (const p of created) {
  process.stdout.write(`${prefix}created ${relative(worktreeRoot, p)}\n`);
}
for (const p of skipped) {
  process.stdout.write(`[junction-worktree] exists ${relative(worktreeRoot, p)}\n`);
}

process.stdout.write(
  `[junction-worktree] ${created.length} link(s) ${dryRun ? 'would be ' : ''}created, ` +
    `${skipped.length} already present.\n`,
);

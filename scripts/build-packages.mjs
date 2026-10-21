#!/usr/bin/env node
/**
 * build-packages.mjs — the ONE authoritative build order for the `@duya/*`
 * workspace packages (plan 587, G0.2).
 *
 * WHY THIS FILE EXISTS
 *
 * Plan 587 G0.2 requires exactly one ordering mechanism: either explicit
 * topological scripts or TypeScript `references`. It explicitly forbids both
 * coexisting with different orders. This repo uses the explicit-scripts option,
 * and THIS ARRAY IS THE SINGLE SOURCE OF TRUTH for that order.
 *
 * Every entry point obtains package prerequisites from this file. The default
 * invocation builds the full monorepo order; `--target <workspace>` builds the
 * target's transitive workspace dependency closure using this same order. No
 * entry point may hand-order a subset or add a package to its own chain — that
 * is precisely how `voice` and `gateway` came to be built ad hoc by the
 * electron scripts and omitted from the package chain.
 *
 * Project references were rejected on evidence, not taste:
 *
 *  1. The real consumers never run `tsc`. `scripts/build-agent-bundle.mjs` and
 *     `scripts/build-electron.mjs` are esbuild, and they resolve `@duya/*`
 *     through `node_modules` into `dist/*.js` without type-checking the
 *     consumer. `references` only orders `tsc` invocations, so it would be
 *     decorative for exactly the paths that break.
 *  2. There is a self-referential edge. `packages/agent/src/journal/Journal.ts`
 *     imports `@duya/agent/message`, which resolves to its own
 *     `packages/agent/dist/message/index.d.ts`. Project references cannot
 *     express a package depending on its own output; building `agent` as the
 *     last step of an explicit chain can.
 *  3. ~153 imports of the form `packages/agent/src/...` from
 *     `apps/desktop/src/main` bypass any tsconfig graph and make
 *     `packages/agent`'s tsconfig the effective type environment for the main
 *     process.
 *
 * THE ORDER
 *
 * Derived from the `@duya/*` import edges in the workspace sources. Packages
 * are grouped into levels; a package always appears after everything it
 * imports. Order WITHIN a level is irrelevant and is chosen for readability.
 * When you add a workspace package or a new `@duya/*` dependency, update this
 * array — and only this array.
 *
 * Usage:
 *   node scripts/build-packages.mjs
 *   node scripts/build-packages.mjs --target @duya/cli
 *
 * Exit codes: 0 = every package built; non-zero = the first failing package's
 * exit code is propagated. Failures are NOT swallowed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

/**
 * The workspace build order. THE SINGLE SOURCE OF TRUTH — see the header.
 *
 * Each entry is a workspace `name`; it is built with that package's own
 * `build` script, so the per-package build command lives in the package that
 * owns it and the order lives only here.
 */
const BUILD_ORDER = [
  // Level 1 — no `@duya/*` imports.
  // `@duya/ai` used to sit here, but plan 587 T3.1 gave it one
  // (`@duya/agent-protocol/transcript`, the moved transcript vocabulary), so
  // it moves down a level. Keeping it in level 1 would have `@duya/ai`
  // typechecking against whatever `agent-protocol/dist` happened to contain —
  // or against a stale declaration for a subpath that does not exist yet.
  '@duya/agent-protocol',
  // Plan 610 A5: the App Connector vocabulary and the `.app.json` declaration
  // schema. Level 1 because it imports NO `@duya/*` package -- `app-schema.ts`
  // imports only `zod` and its sibling. It has to build before the host,
  // because `apps/desktop/tsconfig.main.json` maps `@duya/connectors/*` onto
  // this package's emitted `dist`.
  '@duya/connectors',
  // Plan 610 A5: the cross-platform sandbox capability, moved out of
  // `packages/agent/src/sandbox`. Level 1 because it imports NO `@duya/*`
  // package -- only Node builtins (`child_process`, `fs`, `http`, `os`,
  // `path`) and its own siblings. It has to build before the host, because
  // `packages/sandbox`'s emitted `dist` is what its `exports` map points at.
  '@duya/sandbox',
  // Plan 610: the `/` and `@` completion rules shared by the desktop composer
  // and the CLI TUI prompt. Level 1 because it imports nothing but its own
  // siblings -- no `@duya/*` package, no React, no blessed. It has to build
  // before `@duya/agent` (whose `src/cli/ui/*` imports it) and before the
  // desktop renderer, whose `tsconfig.renderer.json` maps the package onto this
  // one's emitted `dist`.
  //
  // Omitting it here fails in a way that is invisible locally: a workstation
  // that has run `npm run -w @duya/input-completion build` by hand resolves the
  // import from an already-present `dist`, so `typecheck:all` is green while a
  // clean CI checkout reports TS2307 for every file that imports it.
  '@duya/input-completion',
  // The one place a slash command is defined: name, aliases, descriptions,
  // argument shape and which surfaces advertise it, shared by the desktop
  // composer and the CLI TUI. Level 1 because it imports nothing but its own
  // siblings -- no `@duya/*` package, no React, no blessed, no SDK.
  //
  // It must build before `@duya/cli` and before the desktop renderer, both of
  // which resolve it through `node_modules` into this package's emitted `dist`.
  // Omitting it fails exactly the way the `@duya/input-completion` note above
  // describes: a workstation that has built this package by hand is green while
  // a clean checkout typechecks against a missing `dist`. `selectBuildOrder`
  // would also reject `--target @duya/cli` outright, since that target now has
  // a workspace dependency missing from this array.
  '@duya/command-catalog',
  // Plan 610 A8: the extension contract package. Level 1 because it imports
  // no `@duya/*` package at all -- 13 contributor interfaces, the registry,
  // and assembly-time validation, nothing else. It must build before
  // `@duya/capabilities`, whose `fs-contributors.ts` consumes the
  // `ToolContributor` type. (The package existed before this entry; without
  // it, `@duya/capabilities` built against whatever `dist` happened to sit
  // there -- or none.)
  '@duya/tooling',

  // Level 2 — depend only on level 1.
  '@duya/ai', //              -> @duya/agent-protocol
  '@duya/plugin-core',
  // Plan 610 A8: the capability implementations, slice 1 = filesystem
  // (Read/Write/Edit/Glob/Grep/ApplyPatch + BaseTool + contracts + the
  // path-permission policy). Depends on level-1 `@duya/agent-protocol`
  // (transcript types), `@duya/sandbox` (path containment), `@duya/tooling`
  // (contributor declaration), level-2 `@duya/ai` (the `ToolResult` runtime
  // type, same edge `@duya/memory` declares) plus npm `diff`/`picomatch`/
  // `zod`. It must build before `@duya/agent`, whose shims re-export it.
  '@duya/data', //             -> @duya/agent-protocol
  '@duya/conductor',
  '@duya/gateway',
  '@duya/voice',

  // Level 3 — depend only on level 2.
  '@duya/agent-core', //   -> @duya/agent-protocol
  '@duya/client-core', // -> @duya/agent-protocol
  '@duya/computer-use', // -> @duya/ai

  // Source-only shared React renderer. Its build step typechecks the public
  // source tree (it intentionally emits no JS because both Vite surfaces
  // consume the same source entry and stylesheet).
  '@duya/ui', // -> protocol, ai, client-core, conductor, plugin-core, input-completion

  // Concrete browser/CUA and connector adapters consume the platform and
  // plugin contracts, while Runtime consumes their public tool contracts.
  '@duya/capabilities',

  // Level 4 — depend on agent-core, agent-protocol, and client-core.
  '@duya/agent-runtime', // -> @duya/agent-core, @duya/agent-protocol, @duya/client-core

  // Memory is a Host prompt/context prerequisite.
  '@duya/memory', // -> @duya/ai

  // Level 5 — the Host composes the runtime and data packages; CLI connects to it.
  '@duya/host', //         -> @duya/agent-runtime, @duya/data, @duya/agent-protocol
  '@duya/cli', //          -> @duya/host, @duya/plugin-core, @duya/input-completion
  '@duya/web', //          -> @duya/host, @duya/agent-protocol, @duya/ui (Node BFF + shared source renderer)


  // Level 6 — last. `@duya/agent` consumes the level-2 through level-5 packages,
  // and `apps/desktop/src/main` plus the agent bundle both import it, so
  // nothing that needs it can be built or typechecked earlier. It also
  // resolves `@duya/agent/message` to its OWN emitted `dist/message`, so it
  // must be fully built before any step that leans on its emitted types.
  '@duya/agent', // -> @duya/ai, @duya/cli, @duya/computer-use, @duya/plugin-core, @duya/memory
];

const BUILD_ORDER_SET = new Set(BUILD_ORDER);

function parseTarget(args) {
  let target;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target') {
      if (target !== undefined || !args[index + 1]) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace>]');
      }
      target = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--target=')) {
      if (target !== undefined || arg.length === '--target='.length) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace>]');
      }
      target = arg.slice('--target='.length);
    } else {
      throw new Error(`Unknown build-packages argument: ${arg}`);
    }
  }
  return target;
}

function packageDirectory(name) {
  if (name === '@duya/web') return resolve(repoRoot, 'apps', 'web');
  if (!name.startsWith('@duya/')) {
    throw new Error(`Expected a @duya workspace package, got: ${name}`);
  }
  return resolve(repoRoot, 'packages', name.slice('@duya/'.length));
}

function workspaceDependencies(name) {
  const manifestPath = resolve(packageDirectory(name), 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read workspace manifest for ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.name !== name) {
    throw new Error(`Workspace manifest mismatch at ${manifestPath}: expected ${name}, got ${String(manifest.name)}`);
  }

  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].filter((dependency) => dependency.startsWith('@duya/')));
}

function selectBuildOrder(target) {
  if (target === undefined) return BUILD_ORDER;
  if (!BUILD_ORDER_SET.has(target)) {
    throw new Error(`Unknown build target ${target}; expected one of: ${BUILD_ORDER.join(', ')}`);
  }

  const required = new Set();
  const visit = (name) => {
    if (required.has(name)) return;
    required.add(name);
    for (const dependency of workspaceDependencies(name)) {
      if (!BUILD_ORDER_SET.has(dependency)) {
        const dependencyManifest = resolve(packageDirectory(dependency), 'package.json');
        try {
          readFileSync(dependencyManifest, 'utf8');
        } catch {
          continue; // External @duya-scoped dependency, not a workspace package.
        }
        throw new Error(`Workspace dependency ${dependency} of ${name} is missing from BUILD_ORDER`);
      }
      visit(dependency);
    }
  };
  visit(target);
  return BUILD_ORDER.filter((name) => required.has(name));
}

/**
 * Spawn `npm run -w <name> build` for one workspace package.
 *
 * Arguments are always passed as an ARRAY and never concatenated into a
 * command string, so there is no shell interpolation of the package name and
 * no DEP0190 warning. `npm` is a `.cmd` shim on Windows, which modern Node
 * refuses to spawn directly (EINVAL), so Windows goes through the real
 * command interpreter with the arguments kept separate; POSIX has a real
 * `npm` executable and needs no interpreter at all.
 *
 * Async because a LEVEL's packages are built at the same time — see
 * {@link buildLevels} for why that is safe and what it buys.
 */
function runPackageBuild(name) {
  const isWindows = process.platform === 'win32';
  const args = ['run', '-w', name, 'build'];
  const command = isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
  const commandArgs = isWindows ? ['/d', '/s', '/c', 'npm', ...args] : args;
  return new Promise((settle) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      settle(result);
    };
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
    child.on('error', (error) => finish({ error }));
    child.on('close', (status, signal) => finish({ status, signal }));
  });
}

/**
 * Group the selected build order into LEVELS.
 *
 * The order above is already written as levels — the comments in
 * `BUILD_ORDER` say "Level 1", "Level 2" and so on, and the file's own header
 * states that "order WITHIN a level is irrelevant". That makes the levels the
 * parallel unit, and the array's level structure the thing this function
 * derives.
 *
 * The levels are computed from the WORKSPACE DEPENDENCY GRAPH rather than
 * parsed out of the prose, because the graph is the truth and the prose is
 * documentation: a package added to `BUILD_ORDER` without a matching comment
 * would silently get the wrong level if the level came from the comments.
 * The graph says `agent` depends on `cli`, which depends on `host`, which
 * depends on `agent-runtime` — and the level is what keeps that chain
 * ordered while everything beside it runs at the same time.
 */
function buildLevels(selectedOrder) {
  const selected = new Set(selectedOrder);
  const levelOf = new Map();

  const computeLevel = (name, visiting) => {
    if (levelOf.has(name)) return levelOf.get(name);
    if (visiting.has(name)) {
      throw new Error(`Workspace dependency cycle involving ${name}`);
    }
    visiting.add(name);
    let level = 0;
    for (const dependency of workspaceDependencies(name)) {
      if (!selected.has(dependency)) continue;
      level = Math.max(level, computeLevel(dependency, visiting) + 1);
    }
    visiting.delete(name);
    levelOf.set(name, level);
    return level;
  };

  const levels = [];
  for (const name of selectedOrder) {
    const level = computeLevel(name, new Set());
    const bucket = levels[level];
    if (bucket) bucket.push(name);
    else levels[level] = [name];
  }
  return levels;
}

/**
 * How many packages may be built at the same time.
 *
 * Two, deliberately. These builds are `tsc` invocations and each one may
 * hold a multi-gigabyte heap: the renderer's `tsc --noEmit` is the one that
 * aborts with `Abort trap: 6` on the macOS runner when the heap is too
 * small, so a machine full of them at once is a memory question before it is
 * a speed question — and the scheduled run puts a macOS runner next to the
 * Linux ones.
 *
 * Two is also where the time is. The build's critical path is the renderer's
 * typecheck (90s measured on the CI runner) and the web package (37s); every
 * other package is 2-5s. Raising the limit to three would shorten the cheap
 * levels by about three seconds and put a third `tsc` next to the two that
 * are already holding the most memory, which is a bad trade for a nightly
 * signal.
 */
const BUILD_CONCURRENCY = 2;

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

let target;
let selectedOrder;
let levels;
try {
  target = parseTarget(process.argv.slice(2));
  selectedOrder = selectBuildOrder(target);
  levels = buildLevels(selectedOrder);
} catch (error) {
  process.stderr.write(`[build-packages] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(64);
}

const total = selectedOrder.length;
let built = 0;

for (const level of levels) {
  // The capability module content is GENERATED into a source file, so it is
  // produced before the level starts: every package in the level then reads
  // the same content, and the package that owns it builds against it.
  if (level.includes('@duya/capabilities')) {
    const generated = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/inline-modules.mjs')], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    if (generated.error) {
      process.stderr.write(`[build-packages] could not generate capability module content: ${generated.error.message}\n`);
      process.exit(1);
    }
    if (generated.status !== 0) {
      process.stderr.write(`[build-packages] capability module content generation failed with exit ${generated.status}\n`);
      process.exit(generated.status ?? 1);
    }
  }

  const results = await runWithConcurrency(level, BUILD_CONCURRENCY, async (name) => {
    // The label keeps the original "`i/n`" shape: `i` is the package's
    // position in BUILD_ORDER, which is fixed, so a reader can still tell
    // where in the canonical order a package sits even though the packages
    // around it are building at the same time.
    const index = selectedOrder.indexOf(name) + 1;
    process.stdout.write(`[build-packages ${index}/${total}] ${name}\n`);
    const proc = await runPackageBuild(name);
    return { name, proc };
  });

  // The FIRST failing package in BUILD_ORDER is the one reported, so the
  // message names the same package the serial build would have named.
  for (const { name, proc } of results) {
    if (proc.error) {
      process.stderr.write(`[build-packages] could not run npm for ${name}: ${proc.error.message}\n`);
      process.exit(1);
    }
    if (proc.status !== 0) {
      process.stderr.write(`[build-packages] ${name} build failed with exit ${proc.status}\n`);
      process.exit(proc.status ?? 1);
    }
  }
}

process.stdout.write(`[build-packages] built ${total} package(s)${target ? ` for ${target}` : ''}.\n`);

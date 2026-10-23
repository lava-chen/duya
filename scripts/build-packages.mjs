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
 *  1. The real consumers never run `tsc`. `scripts/build-host-worker-bundle.mjs`
 *     and `scripts/build-electron.mjs` are esbuild, and they resolve `@duya/*`
 *     from TypeScript source through the workspacePublicSources plugin without
 *     type-checking the consumer. `references` only orders `tsc` invocations,
 *     so it would be decorative for exactly the paths that break.
 *  2. The remaining consumers DO run `tsc`, and the tsconfig `paths` maps point
 *     `@duya/*` at emitted `dist` declarations. A wrong order therefore
 *     typechecks a package against a stale (or missing) neighbor `dist` —
 *     phantom errors that depend on whatever the workstation last built.
 *
 * Retired packages are NOT in this array. `@duya/agent` was removed (plan 610):
 * it used to sit last because its own source resolved `@duya/agent/message` to
 * its emitted `dist/message` and `apps/desktop/src/main` still imported it.
 * Neither is true any longer, and no script may build it — the retirement gate
 * (`scripts/architecture/agent-retirement-gate.mjs`) keeps watching for a
 * resurrected build path.
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
 *   node scripts/build-packages.mjs --target @duya/cli --target @duya/host
 *   node scripts/build-packages.mjs --profile unit-suite
 *
 * Exit codes: 0 = every package built; non-zero = the first failing package's
 * exit code is propagated. Failures are NOT swallowed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  // before the desktop renderer, whose `tsconfig.renderer.json` maps the
  // package onto this one's emitted `dist`.
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
  // `zod`.
  '@duya/data', //             -> @duya/agent-protocol
  '@duya/gateway',
  '@duya/voice',

  // Level 3 — depend only on level 2.
  '@duya/agent-core', //   -> @duya/agent-protocol
  '@duya/client-core', // -> @duya/agent-protocol

  // Source-only shared React renderer. Its build step typechecks the public
  // source tree (it intentionally emits no JS because both Vite surfaces
  // consume the same source entry and stylesheet).
  '@duya/ui', // -> protocol, ai, client-core, plugin-core, input-completion

  // Builtin filesystem, shell, and connector adapters consume the platform
  // and plugin contracts, while Runtime consumes their public tool contracts.
  '@duya/capabilities',

  // Level 4 — depend on agent-core, agent-protocol, and client-core.
  '@duya/agent-runtime', // -> @duya/agent-core, @duya/agent-protocol, @duya/client-core

  // Memory is a Host prompt/context prerequisite.
  '@duya/memory', // -> @duya/ai

  // Level 5 — the Host composes the runtime and data packages; CLI connects to it.
  '@duya/host', //         -> @duya/agent-runtime, @duya/data, @duya/agent-protocol
  '@duya/cli', //          -> @duya/host, @duya/plugin-core, @duya/input-completion
  '@duya/web', //          -> @duya/host, @duya/agent-protocol, @duya/ui (Node BFF + shared source renderer)
];

const BUILD_ORDER_SET = new Set(BUILD_ORDER);

/**
 * Named build profiles: a SET of targets, named for the consumer that needs
 * them.
 *
 * ## Why a profile instead of a longer `--target` list
 *
 * The unit suite resolves most workspace packages from SOURCE (vitest.config.ts
 * aliases them), and the ones it does not alias it resolves through their
 * `exports` map, which points at `dist/`. The list below is exactly that
 * second set, so a CI job that only has to run the unit suite does not have to
 * build the whole workspace to get it.
 *
 * The saving is not marginal. Measured on 2026-10-22 on this tree, from a
 * clean `dist/` and a clean `tsconfig.tsbuildinfo`:
 *
 *   full build (22 packages)          151.8s
 *   this profile's closure (19)        39.8s
 *
 * The packages the profile leaves out are the expensive ones: `@duya/ui` is a
 * full `tsc` project over the renderer, and the unit suite resolves it from
 * source, not from `dist/`.
 *
 * ## `@duya/host` is here for a reason that is NOT an import
 *
 * No test file imports `@duya/host`. It is in this list because
 * `packages/host/tests/worker-product-runtime/agent-runtime-real-worker.mjs` —
 * the program the subprocess-transport suites actually spawn — loads
 * `packages/host/dist/worker-transport.js`, and the architecture gate
 * requires that import to stay inside the module that owns the worker. So the
 * unit suite needs the host layer's `dist` even though no test names it.
 *
 * Measured, not assumed: with this list minus `@duya/host`, the full suite
 * ran 8 assertions short of green — `subprocess-framing.test.ts` and
 * `transport-equivalence.test.ts`, both failing because the spawned worker
 * produced no output. The suite's own guard ("needs the built worker, and
 * says so rather than skipping") reported it, which is the behaviour it
 * exists for.
 *
 * ## How this stays honest
 *
 * A package that the suite DOES need but that is missing from this list fails
 * the suite at import time, loudly, in the job that builds this profile. That
 * is the intended signal: the profile is wrong and the fix is to add the
 * package here, not to widen the build back to everything.
 *
 * It also means the list is not a constant of the universe. It was derived by
 * measurement, and it moved when the transport fixture moved from the agent
 * layer to the host layer (the agent layer's own copy of the fixture is now
 * unreferenced). A suite whose build requirement can change with a refactor
 * is a suite whose build requirement has to be re-measured, not assumed.
 */
const BUILD_PROFILES = {
  'unit-suite': {
    targets: [
      '@duya/ai',
      '@duya/cli',
      '@duya/gateway',
      '@duya/voice',
      '@duya/plugin-core',
      '@duya/connectors',
      '@duya/host',
    ],
    why: 'the workspace packages the vitest suite resolves through their exports map rather than through a source alias',
  },
};

function parseTarget(args) {
  const targets = [];
  let profile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target') {
      if (!args[index + 1]) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace> ...] [--profile <name>]');
      }
      targets.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith('--target=')) {
      if (arg.length === '--target='.length) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace> ...] [--profile <name>]');
      }
      targets.push(arg.slice('--target='.length));
    } else if (arg === '--profile') {
      if (profile !== undefined || !args[index + 1]) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace> ...] [--profile <name>]');
      }
      profile = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--profile=')) {
      if (profile !== undefined || arg.length === '--profile='.length) {
        throw new Error('Usage: node scripts/build-packages.mjs [--target <workspace> ...] [--profile <name>]');
      }
      profile = arg.slice('--profile='.length);
    } else {
      throw new Error(`Unknown build-packages argument: ${arg}`);
    }
  }
  if (profile !== undefined) {
    const known = BUILD_PROFILES[profile];
    if (!known) {
      throw new Error(`Unknown build profile ${profile}; expected one of: ${Object.keys(BUILD_PROFILES).join(', ')}`);
    }
    for (const target of known.targets) targets.push(target);
  }
  return targets.length === 0 ? undefined : targets;
}

function packageDirectory(name) {
  if (name === '@duya/web') return resolve(repoRoot, 'apps', 'web');
  if (name === '@duya/desktop') return resolve(repoRoot, 'apps', 'desktop');
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

function selectBuildOrder(targets) {
  if (targets === undefined) return BUILD_ORDER;
  const list = Array.isArray(targets) ? targets : [targets];
  for (const target of list) {
    if (BUILD_ORDER_SET.has(target)) continue;
    // App targets (`@duya/desktop`) are never built by this script — an app's
    // own pipeline (vite / electron) owns that. `--target <app>` selects the
    // app's dependency closure: every @duya/* manifest dependency must be in
    // BUILD_ORDER (visit enforces it), the app itself is dropped by the
    // filter below since it is not a BUILD_ORDER member.
    const manifestPath = resolve(packageDirectory(target), 'package.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`Unknown build target ${target}; expected one of: ${BUILD_ORDER.join(', ')}`);
    }
  }

  // Several targets, ONE closure. The union is what a caller that needs two
  // packages actually needs: their shared dependencies are built once, in the
  // canonical order, not twice in two overlapping chains.
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
  for (const target of list) visit(target);
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
 */
function runPackageBuild(name) {
  const isWindows = process.platform === 'win32';
  const args = ['run', '-w', name, 'build'];
  return isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    : spawnSync('npm', args, { cwd: repoRoot, stdio: 'inherit' });
}

let targets;
let selectedOrder;
try {
  targets = parseTarget(process.argv.slice(2));
  selectedOrder = selectBuildOrder(targets);
} catch (error) {
  process.stderr.write(`[build-packages] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(64);
}

for (const [index, name] of selectedOrder.entries()) {
  const label = `build-packages ${index + 1}/${selectedOrder.length}`;
  process.stdout.write(`[${label}] ${name}\n`);

  if (name === '@duya/capabilities') {
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

  const proc = runPackageBuild(name);

  if (proc.error) {
    process.stderr.write(`[build-packages] could not run npm for ${name}: ${proc.error.message}\n`);
    process.exit(1);
  }
  if (proc.status !== 0) {
    process.stderr.write(`[build-packages] ${name} build failed with exit ${proc.status}\n`);
    process.exit(proc.status ?? 1);
  }
}

process.stdout.write(
  `[build-packages] built ${selectedOrder.length} package(s)${targets ? ` for ${targets.join(', ')}` : ''}.\n`,
);

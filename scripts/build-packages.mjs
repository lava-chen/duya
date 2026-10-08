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
 * Every entry point (`typecheck:web`, `typecheck:electron`, `bundle:agent`,
 * `electron:build`, `electron:dev`, `pretest`, …) obtains its prerequisites by
 * calling `npm run build:packages`, which runs this file. No entry point may
 * hand-order a subset of these packages, and no entry point may add a package
 * to its own chain — that is precisely how `voice` and `gateway` came to be
 * built ad hoc by the electron scripts and omitted from the package chain.
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
 *
 * Exit codes: 0 = every package built; non-zero = the first failing package's
 * exit code is propagated. Failures are NOT swallowed.
 */

import { spawnSync } from 'node:child_process';
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

  // Level 2 — depend only on level 1.
  '@duya/ai', //              -> @duya/agent-protocol
  '@duya/plugin-core',
  '@duya/conductor',
  '@duya/gateway',
  '@duya/voice',

  // Level 3 — depend only on level 2.
  '@duya/agent-core', //   -> @duya/agent-protocol
  '@duya/computer-use', // -> @duya/ai
  '@duya/cli', //          -> @duya/plugin-core

  // Level 4.
  '@duya/agent-runtime', // -> @duya/agent-core, @duya/agent-protocol

  // Level 5.
  //
  // `@duya/memory` sits at level 5 because its only `@duya/*` dependency is
  // `@duya/ai` (level 2) and its only consumers are `@duya/agent` and
  // `apps/desktop`. Both need its emitted `dist`, so it must be built before
  // either — and it must not be hoisted earlier, or a package that imports it
  // could typecheck against a `dist` that does not exist yet.
  '@duya/memory', //           -> @duya/ai

  // Level 5 — last. `@duya/agent` consumes the four level-2/3 packages above,
  // and `apps/desktop/src/main` plus the agent bundle both import it, so
  // nothing that needs it can be built or typechecked earlier. It also
  // resolves `@duya/agent/message` to its OWN emitted `dist/message`, so it
  // must be fully built before any step that leans on its emitted types.
  '@duya/agent', // -> @duya/ai, @duya/cli, @duya/computer-use, @duya/plugin-core, @duya/memory
];

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

for (const [index, name] of BUILD_ORDER.entries()) {
  const label = `build-packages ${index + 1}/${BUILD_ORDER.length}`;
  process.stdout.write(`[${label}] ${name}\n`);

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

process.stdout.write(`[build-packages] all ${BUILD_ORDER.length} packages built.\n`);

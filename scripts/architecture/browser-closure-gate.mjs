#!/usr/bin/env node
/**
 * browser-closure-gate.mjs — plan 610 §4, gate G10.
 *
 * > G10: the value-import closure of a browser entry point must not contain a
 * > Node built-in.
 *
 * ## Why this is a gate and not a convention
 *
 * Plan 610 A0 asked "can one core drive CLI, Web and Desktop at the same time?"
 * and measured the answer as NO. The blocker was not the packages: it was that
 * the desktop renderer reached `@duya/ai`, whose barrel re-exports the Bedrock
 * adapter, which imported `node:crypto`. Electron's renderer ships with Node,
 * so that coupling is invisible until the same code is loaded by a browser,
 * where it is fatal. Nothing in the repo could see it, and nothing would have
 * gone red if someone added a second one.
 *
 * ## What the closure follows, and what it deliberately does not
 *
 * It follows VALUE imports only, reusing the repo's existing resolvers rather
 * than adding a fourth scanner:
 *
 *   - `importsOf` (import-graph.mjs)      — specifier extraction, and the
 *                                            type / value classification
 *   - `resolveRepoSpecifier` (boundary-gates.mjs) — package-aware resolution
 *   - `isTestPath` (boundary-gates.mjs)   — the test-path rule the other gates
 *                                            already use
 *
 * `import-graph.mjs`'s own `resolveTarget` is NOT enough here, and the reason is
 * recorded in `boundary-gates.mjs:314-321`: it maps `@duya/x` to
 * `packages/x`, the package ROOT, while every source file lives under
 * `packages/x/src`. A closure built on it would follow NO cross-package edge at
 * all, and the Node module this gate exists to catch sits behind exactly one
 * package boundary. A gate that cannot look must say so, not report OK.
 *
 * `import type` is NOT a runtime edge. `import type { X } from 'y'` and
 * `export type { X } from 'y'` are erased by the compiler, so they cannot drag a
 * module into a bundle. This is load-bearing here rather than theoretical:
 * `packages/plugin-core/src/index.ts` re-exports `MCPCollectorInput` and friends
 * from `./mcp/collect`, a module that imports `fs` and `path`. Counting it as a
 * value edge would make G10 permanently red for a coupling that does not exist
 * at runtime. The erring direction is chosen deliberately: a missed type-only
 * import costs one manual look, whereas counting types as values would train
 * everyone to ignore the gate. The one form this treatment cannot see is
 * `import('./x.js')` behind a variable, which `importsOf` does not resolve — a
 * limit inherited from every other audit in this directory, not introduced here.
 *
 * ## Bare built-ins count, and that is the half that is easy to get wrong
 *
 * `node:crypto` is the spelling a scan for. `packages/plugin-core/src/security/
 * path-validator.ts` does not spell it that way — it writes `import fs from
 * 'fs'` — and a `node:`-only pattern reports that package as clean. Measured on
 * the A0 tree: a `node:`-only scan finds 2 Node-touching files in
 * `@duya/plugin-core`, and the bare-inclusive scan finds 5. A gate that reports
 * the smaller number is worse than no gate, because it is cited as evidence.
 *
 * ## What is NOT claimed
 *
 * A third-party package that itself imports `node:fs` is invisible: the walk
 * stops at any specifier that does not resolve inside this repo. So G10 says the
 * FIRST-party closure of the browser entry is clean; it does not certify the
 * emitted bundle. And an entry that does not exist yet is reported as absent
 * rather than skipped silently — see `BROWSER_ENTRIES`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, importsOf, rel, walk } from './import-graph.mjs';
import { isTestPath, resolveRepoSpecifier } from './boundary-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The browser entry points, each with whether it exists yet.
 *
 * `apps/web/src/main.tsx` is the entry a Web client will have and does not have
 * yet. It is listed rather than omitted on purpose: an absent entry is a fact
 * this gate reports (`absentEntries`), so the day the skeleton lands the gate
 * starts covering it with no edit here. Inventing an `apps/web` skeleton to
 * satisfy the entry list would create a second, fake client.
 */
export const BROWSER_ENTRIES = [
  { rel: 'apps/desktop/src/renderer', kind: 'dir' },
  { rel: 'apps/web/src/main.tsx', kind: 'file' },
];

/**
 * Node built-ins a browser cannot load, as a specifier test.
 *
 * Matched in two spellings on purpose: `node:fs` and the bare `fs`. Node has
 * accepted both since forever, the repo uses both, and the bare form is the one
 * a `node:`-anchored pattern silently misses. `sqlite` is spelled both ways
 * because the native module is `better-sqlite3` and the built-in is
 * `node:sqlite`. The list is checked against a single class of subject — a
 * module specifier — so it errs toward including a name that is a Node module
 * and away from excluding one that is not.
 */
export const NODE_BUILTIN_RE =
  /^(?:node:[a-z0-9_/]+|(?:assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|sea|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib|sqlite|sqlite3|better-sqlite3))$/;

export const isNodeBuiltinSpecifier = (spec) => NODE_BUILTIN_RE.test(spec);

/**
 * The seed files for one entry, with tests excluded.
 *
 * Excluding tests is the rule the rest of the boundary gates already apply
 * (`isTestPath`): `apps/desktop/src/renderer/**` contains two test files that
 * legitimately `import fs` to read fixtures, and a gate that counts them would
 * be red for a file the bundler never loads. A test file is not the subject.
 */
export function seedsFor(entryRel) {
  const abs = path.join(ROOT, entryRel);
  if (!fs.existsSync(abs)) return null;
  const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
  return files.map(rel).filter((f) => !isTestPath(f)).sort();
}

/**
 * The value-import closure of `seeds`, as `file -> the file that reached it`.
 *
 * The parent map is what lets a finding name the path a Node built-in arrived
 * through, which is the difference between an actionable report and a list of
 * files to grep.
 */
export function browserClosure(seeds) {
  const parent = new Map();
  const queue = [...seeds];
  for (const seed of seeds) parent.set(seed, null);
  const done = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (done.has(current)) continue;
    done.add(current);
    for (const { spec, typeOnly } of importsOf(path.join(ROOT, current))) {
      if (typeOnly) continue;
      const to = resolveRepoSpecifier(spec, current);
      if (to === null || parent.has(to)) continue;
      parent.set(to, current);
      queue.push(to);
    }
  }
  return parent;
}

/**
 * Walk every present browser entry and report the Node built-ins it reaches.
 *
 * Only VALUE imports of a built-in are findings. A type-only one
 * (`import type { X } from 'node:crypto'`, which this tree had in
 * `packages/ai/src/api/bedrock-converse.ts` before plan 610) is erased by the
 * compiler and cannot reach a bundle, so making it red would be a false
 * positive. It is not thrown away either: `typeOnlyBuiltins` counts them, so
 * the treatment is visible to a reader instead of being a silent omission.
 *
 * `absentEntries` is returned rather than logged so a caller can assert on it; a
 * caller that ignores it can still tell an empty tree from an empty walk, because
 * `walked` is the sum of the closures and a real entry contributes hundreds of
 * files.
 */
export function collectBrowserClosureReport(entries = BROWSER_ENTRIES) {
  const present = [];
  const absentEntries = [];
  for (const entry of entries) {
    const seeds = seedsFor(entry.rel);
    if (seeds === null) {
      absentEntries.push(entry.rel);
      continue;
    }
    present.push({ rel: entry.rel, seeds });
  }

  const findings = [];
  const typeOnlyBuiltins = [];
  let walked = 0;
  const sizes = [];
  for (const { rel: entryRel, seeds } of present) {
    const closure = browserClosure(seeds);
    walked += closure.size;
    sizes.push({ rel: entryRel, seeds: seeds.length, closure: closure.size });
    for (const [file, via] of closure) {
      for (const { spec, typeOnly } of importsOf(path.join(ROOT, file))) {
        if (!isNodeBuiltinSpecifier(spec)) continue;
        const reach = { file, spec, from: entryRel, via };
        if (typeOnly) typeOnlyBuiltins.push(reach);
        else findings.push(reach);
      }
    }
  }

  const scope = present.map((e) => e.rel).join(' + ') || 'no present entry';
  return {
    scope,
    // `<bad>/<walked> in <scope>`: the denominator is the number of files the
    // walk actually opened, so `0/0` — a green gate that looked at nothing —
    // is visibly different from a green gate that looked at hundreds of files.
    summary: `${findings.length}/${walked} Node built-ins in ${scope}`,
    entries: sizes,
    absentEntries,
    findings,
    typeOnlyBuiltins,
    walked,
  };
}

/** True when the closure is clean. An absent entry does not make it red. */
export function isBrowserClosureClean(report) {
  return report.findings.length === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = collectBrowserClosureReport();
  for (const finding of report.findings) {
    process.stdout.write(
      `G10  ${finding.file} imports '${finding.spec}' as a VALUE` +
        ` — reachable from ${finding.from}` +
        `${finding.via ? ` via ${finding.via}` : ''}\n`,
    );
  }
  for (const entry of report.entries) {
    process.stdout.write(
      `     ${entry.rel}: ${entry.seeds} seeds, ${entry.closure} files in closure\n`,
    );
  }
  for (const reach of report.typeOnlyBuiltins) {
    process.stdout.write(
      `     (type-only, not counted) ${reach.file} imports '${reach.spec}'\n`,
    );
  }
  if (report.absentEntries.length > 0) {
    process.stdout.write(
      `     entries not on this tree yet: ${report.absentEntries.join(', ')}\n`,
    );
  }
  process.stdout.write(`G10  ${isBrowserClosureClean(report) ? 'PASS' : 'FAIL'}  ${report.summary}\n`);
  process.exit(isBrowserClosureClean(report) ? 0 : 1);
}

#!/usr/bin/env node
/**
 * client-closure-gate.mjs — plan 610 §5, gate G11-1.
 *
 * > G11-1: a CLIENT entry point must not reach the agent RUNTIME through value
 * > imports.
 *
 * ## Why this is a gate and not a convention
 *
 * Plan 610's premise is that the runtime (`@duya/agent-runtime`) is the thing
 * that OWNS a run, and a client is the thing that TALKS to a run. Once a client
 * can reach the runtime by a static value import, the process boundary stops
 * being structural: the client can construct `RunEngineImpl` in its own process,
 * the HTTP/SSE hop becomes optional, and "the CLI and the Desktop share one
 * core" quietly degrades into "everyone links everything". That is exactly the
 * failure mode plan 587 spent six phases pulling apart, and it re-grows one
 * convenient import at a time.
 *
 * Nothing else in the repo can see it. `findReverseEdges` (boundary-gates.mjs)
 * works on the LAYER table, and `@duya/host` → `@duya/agent-runtime` is a legal
 * layer edge — the pollution arrives through three legitimately-layered hops,
 * so every layer rule is satisfied while the runtime ends up inside the client
 * closure. Only a closure can see that.
 *
 * ## What the closure follows, and what it deliberately does not
 *
 * VALUE imports only, reusing the repo's existing resolvers rather than adding
 * a fourth scanner — same three the G10 gate uses:
 *
 *   - `importsOf` (import-graph.mjs)               — specifier extraction and
 *                                                    the type / value split
 *   - `resolveRepoSpecifier` (boundary-gates.mjs)  — package-aware resolution
 *   - `isTestPath` (boundary-gates.mjs)            — "tests are not the subject"
 *
 * `import-graph.mjs`'s `resolveTarget` is NOT usable here, and `boundary-gates
 * .mjs:314-321` records why: it maps `@duya/x` to `packages/x`, the package
 * ROOT, while sources live under `packages/x/src`, so a closure built on it
 * follows NO cross-package edge and reports a clean client forever. That bug
 * shipped once in G10's first draft. The `walked` floor below is the guard.
 *
 * `import type` is not a runtime edge — erased by the compiler. This is
 * load-bearing on this tree rather than theoretical: `packages/cli/src/chat.ts`
 * type-imports from `@duya/agent-protocol`, `@duya/input-completion` and
 * `@duya/host`, and `packages/client-core/src/surface/surface-model.ts` is
 * built almost entirely out of a type-only `@duya/agent-protocol` import.
 * Counting those would make this gate red for couplings that do not exist. The
 * erring direction is chosen deliberately: a missed type-only import costs one
 * manual look; counting types as values trains everyone to ignore the gate. A
 * type-only reference to the runtime is NOT thrown away — it is counted in
 * `typeOnlyRefs`, so the treatment is visible instead of silent.
 *
 * ## Two roots, and why both
 *
 *   - `packages/client-core/src/index.ts` — the shared client core barrel. Its
 *     closure is TINY (one module), so this root alone would make a `walked > 0`
 *     assertion pass while proving almost nothing. It is the root that must stay
 *     small, which is precisely why it needs a gate and not a comment.
 *   - `packages/cli/src/chat.ts` — the CLI client entry, which is the one that
 *     has an actual reason to reach `@duya/host` (it starts a local host). This
 *     is where the pollution lives today.
 *
 * Each root is measured and judged SEPARATELY, because they fail differently: a
 * collapsed `walked` sum would let `client-core` go blind while `chat.ts`'s
 * hundreds of files kept the total healthy.
 *
 * ## What is NOT claimed
 *
 * A third-party package that itself imports `@duya/agent-runtime` is invisible:
 * the walk stops at any specifier that does not resolve inside this repo. So
 * G11-1 says the FIRST-party value closure of these entries is clean; it does
 * not certify an emitted bundle. Dynamic `import('./x.js')` behind a variable is
 * also unseen — a limit inherited from every audit in this directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOT, importsOf, rel } from './import-graph.mjs';
import { isTestPath, resolveRepoSpecifier } from './boundary-gates.mjs';

/**
 * Modules a client closure must not reach through value imports.
 *
 * Both halves of the runtime are named: `@duya/agent-core` is zero-I/O reasoning
 * but it is still the runtime's brain, and plan 610 draws the client line at
 * `@duya/agent-protocol` (types) — reaching core is the same coupling one hop
 * further out.
 */
export const FORBIDDEN_PACKAGES = ['@duya/agent-runtime', '@duya/agent-core'];

/**
 * The client entries. `kind: 'file'` because a directory root would make every
 * file under it a seed, which hides the reachability path this gate reports.
 */
export const CLIENT_ENTRIES = [
  { rel: 'packages/client-core/src/index.ts', kind: 'file' },
  { rel: 'packages/cli/src/chat.ts', kind: 'file' },
];

const FORBIDDEN_DIRS = FORBIDDEN_PACKAGES.map((name) => `packages/${name.slice('@duya/'.length)}/`);

/**
 * The package a repo-relative file belongs to, or null.
 *
 * Findings are reported per package boundary crossed, not per file, so a
 * violation reads as "the closure entered `@duya/agent-runtime`" rather than
 * "43 files, here they are".
 */
export function forbiddenOwnerOf(fileRel) {
  for (let i = 0; i < FORBIDDEN_PACKAGES.length; i += 1) {
    if (fileRel.startsWith(FORBIDDEN_DIRS[i])) return FORBIDDEN_PACKAGES[i];
  }
  return null;
}

/**
 * The value-import closure of one entry, as `file -> the file that reached it`.
 *
 * `parent` is what turns a list of 49 polluted files into one actionable chain:
 * a violation reports the FIRST file the closure entered the forbidden package
 * through, plus the hop that imported it, which names the edge to sever.
 *
 * Test files are not seeds and are not traversed — `isTestPath`, the rule every
 * boundary gate here applies. A test may legitimately construct the runtime.
 */
export function clientClosure(entryRel) {
  const abs = path.join(ROOT, entryRel);
  if (!fs.existsSync(abs)) return null;
  const parent = new Map([[entryRel, null]]);
  const queue = [entryRel];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const currentAbs = path.join(ROOT, current);
    if (!fs.existsSync(currentAbs)) continue;
    for (const { spec, typeOnly } of importsOf(currentAbs)) {
      if (typeOnly) continue;
      const to = resolveRepoSpecifier(spec, current);
      if (to === null || parent.has(to)) continue;
      if (isTestPath(to)) continue;
      parent.set(to, current);
      queue.push(to);
    }
  }
  return parent;
}

/** Walk the parent map back to the entry. Returns [entry, ..., file]. */
export function pathTo(parent, file) {
  const chain = [];
  let cursor = file;
  while (cursor !== undefined && cursor !== null) {
    chain.unshift(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  return chain;
}

/**
 * Measure every client entry and return one report per entry.
 *
 * A root that does not exist is reported as `absent`, never as clean: a missing
 * entry is the quietest possible blind state.
 */
export function collectClientClosureReport(entries = CLIENT_ENTRIES) {
  const reports = [];
  for (const entry of entries) {
    const parent = clientClosure(entry.rel);
    if (parent === null) {
      reports.push({
        entry: entry.rel,
        absent: true,
        walked: 0,
        findings: [],
        typeOnlyRefs: [],
        summary: `absent: ${entry.rel}`,
        clean: false,
      });
      continue;
    }

    // One finding per forbidden package: the FIRST file entered, with the hop
    // that imported it. Later files in the same package are consequences, and
    // listing all 49 buries the edge that has to be severed.
    const firstEntryOf = new Map();
    const typeOnlyRefs = [];
    for (const file of parent.keys()) {
      const owner = forbiddenOwnerOf(file);
      if (owner !== null && !firstEntryOf.has(owner)) {
        firstEntryOf.set(owner, { file, via: parent.get(file) ?? null });
      }
      for (const { spec, typeOnly } of importsOf(path.join(ROOT, file))) {
        if (!typeOnly) continue;
        if (FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
          typeOnlyRefs.push({ file, spec });
        }
      }
    }

    const findings = [];
    for (const owner of FORBIDDEN_PACKAGES) {
      const hit = firstEntryOf.get(owner);
      if (!hit) continue;
      const reached = [...parent.keys()].filter((f) => forbiddenOwnerOf(f) === owner);
      findings.push({
        package: owner,
        file: hit.file,
        via: hit.via,
        reached: reached.length,
        chain: pathTo(parent, hit.file),
      });
    }

    const walked = parent.size;
    // `<bad>/<walked> in <entry>`: the denominator is what the walk opened, so
    // `0/1` (a root with no imports) is visibly different from `0/317`. Only
    // `walked >= MIN_WALKED` can be clean — see `MIN_WALKED`.
    const scope = `${entry.rel}`;
    reports.push({
      entry: entry.rel,
      absent: false,
      walked,
      findings,
      typeOnlyRefs,
      summary: `${findings.length}/${walked} forbidden packages in ${scope}`,
      clean: findings.length === 0 && walked >= MIN_WALKED,
    });
  }
  return reports;
}

/**
 * The minimum closure size that counts as "the walk actually followed an edge".
 *
 * `1` is the entry itself, and ONLY the entry itself: an empty or import-free
 * root produces exactly that. Two is therefore the smallest non-blind closure.
 *
 * The first draft of this gate used `walked > 0`, and a mutation proof caught it
 * doing the exact thing the gate exists to prevent — emptying
 * `packages/client-core/src/index.ts` left `walked === 1`, zero findings, and the
 * gate reported that entry CLEAN. A count of one is not a measurement of a
 * closure; it is a measurement of "I opened the file the caller named".
 */
const MIN_WALKED = 2;

/** True when this report measured a real closure rather than just the entry. */
export function isMeasured(report) {
  return report.absent !== true && report.walked >= MIN_WALKED;
}

/**
 * True only when the report BOTH found nothing AND measured a real closure.
 *
 * The `isMeasured` conjunct is the whole point: a resolver break — or an emptied
 * root — collapses the closure to a single node, every count is zero, and a
 * plain `findings.length === 0` reports PASS while enforcing nothing.
 */
export function isClientClosureClean(report) {
  return report.clean === true;
}

/** True when every entry in the set is clean. */
export function isEveryClientEntryClean(reports) {
  return reports.length > 0 && reports.every(isClientClosureClean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reports = collectClientClosureReport();
  for (const report of reports) {
    if (report.absent) {
      process.stdout.write(`G11-1  ABSENT  ${report.entry} is not on this tree\n`);
      continue;
    }
    for (const finding of report.findings) {
      process.stdout.write(
        `G11-1  ${finding.package} reached from ${report.entry}` +
          ` (${finding.reached} file(s)) — first entered at ${finding.file}` +
          `${finding.via ? `, imported by ${finding.via}` : ''}\n`,
      );
      if (finding.chain.length > 1) {
        process.stdout.write(`         chain: ${finding.chain.join('\n              -> ')}\n`);
      }
    }
    for (const ref of report.typeOnlyRefs) {
      process.stdout.write(`         (type-only, not counted) ${ref.file} imports '${ref.spec}'\n`);
    }
    if (!isMeasured(report)) {
      process.stdout.write(
        `G11-1  BLIND  ${report.entry} closure walks ${report.walked} file(s) — ` +
          `the entry has no imports, or the resolver is broken. Neither is clean.\n`,
      );
    }
    process.stdout.write(`         ${report.entry}: ${report.walked} files in closure\n`);
  }
  const total = reports.length;
  const bad = reports.filter((r) => !isClientClosureClean(r)).length;
  process.stdout.write(
    `G11-1  ${isEveryClientEntryClean(reports) ? 'PASS' : 'FAIL'}  ` +
      `${bad}/${total} client entries clean (${reports.map((r) => `${r.entry}=${r.walked}`).join(', ')})\n`,
  );
  process.exit(isEveryClientEntryClean(reports) ? 0 : 1);
}

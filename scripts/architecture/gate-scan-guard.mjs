#!/usr/bin/env node
/**
 * gate-scan-guard.mjs — assert that a gate measured something.
 *
 * ## Why this file exists
 *
 * Both gates this guards (G10 browser closure, A1 headless load) decide
 * "clean" by a COUNT being zero. `browser-closure-gate.mjs` is
 * `findings.length === 0`; `headless-load-gate.mjs` is
 * `hard.length === 0 && unexplained.length === 0 && attributed.length === 0`.
 *
 * A count of zero is also what you get when the walk followed nothing at all.
 * If the resolver breaks — the module-root matcher stops mapping files to
 * modules, or the entry directory moves — the gate still exits 0, still prints
 * `PASS`, and has enforced precisely nothing. `test.yml` already guards
 * `architecture:check` for exactly this reason ("a gate that cannot tell
 * 'clean' from 'blind' is the exact failure this repo already paid for once"),
 * and these two gates were about to be promoted into CI with no such guard.
 *
 * So the guard is deliberately NOT a second verdict. It never re-decides
 * whether the gate passes. It answers one separate question: did the gate look
 * at anything? A green gate that scanned 0 files fails here; a red gate that
 * scanned 500 files passes here and is the gate step's business.
 *
 * ## Why it imports rather than re-parses
 *
 * Both gate modules guard their entry point with
 * `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`, so
 * importing them runs no gate and starts no probe as a side effect. The guard
 * calls the SAME exported collector the CLI calls, so the number it checks and
 * the number the gate reported come from one measurement, not two parsers that
 * can drift. `browser-closure-gate.test.ts` already imports the module the same
 * way, so this path is exercised.
 *
 * Cost is one extra measurement (A1 re-runs a child-process probe, ~2.6s)
 * inside a job that already runs `npm ci` for three platforms. Cheap.
 *
 * ## What a failure means
 *
 * It is a RESOLVER failure under `scripts/architecture/`, not a clean repo. The
 * message says so, because the failure mode people reach for first is "the
 * gate is flaky, re-run it", and re-running a blind gate gives the same blind
 * answer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectBrowserClosureReport } from './browser-closure-gate.mjs';
import { collectHeadlessReport } from './headless-load-gate.mjs';

/**
 * The gates this guard knows how to check.
 *
 * Each entry returns `{ scope, checks }` where every check is
 * `{ what, ok, observed }`. `scope` is the `<passing>/<total> in <scope>`-style
 * denominator the project's gate-reporting rule requires: a bare number is not
 * readable, and a reader cannot tell a small scope from a collapsed one.
 *
 * The `*Checks` builders are exported and PURE -- they take a report and
 * return checks -- so `gate-scan-guard.test.ts` can pin them with a synthetic
 * blind report. That test is not decoration: a guard whose own body is edited
 * into `checks: []` would pass CI forever while enforcing nothing, and this
 * file has no other protection against that. `GUARDS` itself stays private,
 * because the collector calls inside it are what the mutation proofs cover.
 */
export const BROWSER_CLOSURE_CHECKS = {
  /**
   * G10 — browser value-import closure.
   *
   * Two independent blind modes, because they fail differently:
   *   1. `entries` empty  — no browser entry exists on the tree at all. The
   *      gate treats absent entries as non-red by design (the `apps/web`
   *      skeleton does not exist yet), so this is the quietest blind state:
   *      nothing present, nothing scanned, exit 0.
   *   2. `walked` zero    — entries were found but the resolver followed no
   *      value edge out of them. This is the resolver-break case.
   */
  fromReport(report) {
    return {
      scope: `${report.walked} files walked, ${report.entries.length} present entry/entries`,
      checks: [
        {
          what: 'at least one browser entry is present on this tree',
          ok: report.entries.length > 0,
          observed: `${report.entries.length} present, absent: [${report.absentEntries.join(', ')}]`,
        },
        {
          what: 'the value-import closure followed at least one edge',
          ok: report.walked > 0,
          observed: `walked ${report.walked} file(s)`,
        },
        {
          what: 'each present entry contributed seeds',
          ok: report.entries.every((e) => e.seeds > 0),
          observed: report.entries.map((e) => `${e.rel}=${e.seeds}`).join(', ') || '(none)',
        },
      ],
    };
  },
};

/**
 * A1 — headless load of the cli handler layer.
 *
 * `patchArmed` is already part of `verdictOf`, so a disarmed probe turns the
 * gate red by itself; it is repeated here only so the guard's own output
 * names it. The two SCOPE checks are what this guard is really for: with an
 * empty handler layer every list in the verdict is empty and every one of
 * those `=== 0` comparisons holds.
 */
export const HEADLESS_LOAD_CHECKS = {
  fromReport(report) {
    return {
      scope: `${report.a1a.scope} modules in the handler layer, ${report.a1b.scope} probed`,
      checks: [
        {
          what: 'the handler layer is non-empty',
          ok: report.a1a.scope > 0,
          observed: `A1a scope ${report.a1a.scope}`,
        },
        {
          what: 'the probe actually ran against modules',
          ok: report.a1b.scope > 0,
          observed: `A1b scope ${report.a1b.scope}`,
        },
        {
          what: "the require('electron') refusal patch was armed",
          ok: report.a1b.patchArmed === true,
          observed: `patchArmed ${report.a1b.patchArmed}`,
        },
        {
          what: 'the probe reported no error',
          ok: report.a1b.probeError === null,
          observed: report.a1b.probeError === null ? 'null' : String(report.a1b.probeError),
        },
      ],
    };
  },
};

const GUARDS = {
  g10: () => BROWSER_CLOSURE_CHECKS.fromReport(collectBrowserClosureReport()),
  a1: async () => HEADLESS_LOAD_CHECKS.fromReport(await collectHeadlessReport({ strict: false })),
};

function summarise(gate, result, lines) {
  lines.push(`### gate-scan-guard: ${gate}`, '', `scope: ${result.scope}`, '');
  for (const c of result.checks) {
    lines.push(`- ${c.ok ? 'ok' : 'FAILED'}: ${c.what} — observed ${c.observed}`);
  }
  return lines.join('\n');
}

async function main() {
  const gate = process.argv[2];
  if (!gate || !(gate in GUARDS)) {
    process.stderr.write(
      `usage: node scripts/architecture/gate-scan-guard.mjs <${Object.keys(GUARDS).join('|')}>\n`,
    );
    process.exit(2);
  }

  let result;
  try {
    result = await GUARDS[gate]();
  } catch (err) {
    process.stderr.write(
      `\nguard FAILED: could not measure ${gate} at all: ${err?.stack ?? err}\n` +
        'A gate that cannot be measured is not a passing gate.\n',
    );
    process.exit(1);
  }

  const failed = result.checks.filter((c) => !c.ok);
  const text = summarise(gate, result, []);
  process.stdout.write(`${text}\n`);

  const summaryTarget = process.env.GITHUB_STEP_SUMMARY;
  if (summaryTarget) {
    try {
      fs.appendFileSync(summaryTarget, `${text}\n\n`);
    } catch {
      // A missing step summary must never fail the guard.
    }
  }

  if (failed.length > 0) {
    process.stderr.write(
      `\nguard FAILED: ${gate} scanned nothing usable, so its clean verdict proves nothing.\n` +
        `  ${failed.map((c) => `${c.what} (${c.observed})`).join('\n  ')}\n` +
        'Treat this as a resolver failure under scripts/architecture/, not as a\n' +
        'clean repo, and not as a flake. Re-running a blind gate returns the\n' +
        'same blind answer.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`\nguard OK: ${gate} scanned a non-empty scope.\n`);
}

/**
 * Entry point.
 *
 * Guarded by the same argv comparison the two gate modules use, and for the
 * same reason plus one: `gate-scan-guard.test.ts` imports the `*Checks`
 * builders from this file, so an unguarded top-level `await main()` would run
 * the guard -- with `process.argv[2]` undefined -- and `process.exit(2)` the
 * whole test run. Importing this module must measure nothing and exit nothing.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

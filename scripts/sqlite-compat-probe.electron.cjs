#!/usr/bin/env node
/**
 * sqlite-compat-probe.electron.cjs — run the SQLite compat probe inside a real
 * Electron MAIN process.
 *
 * ## Why a second entry point instead of `ELECTRON_RUN_AS_NODE=1`
 *
 * `ELECTRON_RUN_AS_NODE=1 electron script.js` executes the script in Electron's
 * bundled Node but NOT in the Electron main process — no `app`, no Chromium, no
 * Electron module environment. The plan requires the Electron MAIN process
 * specifically, because that is the runtime where `apps/desktop/src/main/db`
 * actually opens databases. RUN_AS_NODE would answer a different, weaker
 * question. So this file is launched as `electron scripts/sqlite-compat-probe.electron.cjs`,
 * which puts the probe inside a real main process.
 *
 * ## Why the probe is imported rather than duplicated
 *
 * The nine checks live in exactly one file (`sqlite-compat-probe.mjs`). If the
 * Electron run had its own copy of the checks, the two runtimes could drift and
 * a green report would no longer mean the same thing in both. This launcher
 * only supplies the Electron-specific parts: wait for `app`, run, flush the
 * report, quit with the probe's exit code.
 *
 * ## Why it must not reuse better-sqlite3's binary assumptions
 *
 * The probe loads better-sqlite3 only as the SECOND source for cross-driver
 * comparisons. If that load fails (e.g. a wrong-ABI native binary), items 2/3/5/6/8/9
 * degrade to comparing against hand-derived literals only, and item 1's OS-lock
 * discriminator is unaffected. The probe reports which comparisons actually ran
 * rather than silently substituting a weaker check — a degraded run must be
 * visible as degraded.
 *
 * Usage: npx electron scripts/sqlite-compat-probe.electron.cjs
 */

'use strict';

const path = require('node:path');

const PROBE_PATH = path.join(__dirname, 'sqlite-compat-probe.mjs');

const { app } = require('electron');

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const probe = await import(`file://${PROBE_PATH.replace(/\\/g, '/')}`);
    const report = await probe.runProbe();

    // The same machine-readable envelope the node run emits, so both runs are
    // captured by one parser.
    process.stdout.write(
      `${probe.SENTINEL_OPEN}\n${JSON.stringify(report, null, 2)}\n${probe.SENTINEL_CLOSE}\n`,
    );
    exitCode = report.summary.exitCode;
  } catch (err) {
    // A launcher that cannot run the probe is a failed run, not a skipped one.
    process.stderr.write(
      `${JSON.stringify({
        component: 'SqliteCompatProbe',
        level: 'FATAL',
        message: 'electron launcher failed',
        error: String((err && err.stack) || err).slice(0, 2000),
      })}\n`,
    );
    exitCode = 1;
  } finally {
    // `exit` rather than `quit`: quit() waits for the event loop, and a probe
    // holding no windows must not be able to hang a CI step.
    app.exit(exitCode);
  }
});

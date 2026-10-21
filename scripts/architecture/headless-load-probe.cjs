/**
 * headless-load-probe.cjs — the child process of gate A1b.
 *
 * ## What makes this a behavioural gate and not another scan
 *
 * `01-headless-control-plane.md` §3.1 asks for the one thing a static check
 * cannot do: make `require('electron')` genuinely unavailable, then LOAD the
 * real module graph and see whether it survives. So this file:
 *
 *   1. patches `Module._load` so that any request for `electron` throws. It
 *      is a resolution hook, not a string check, so an aliased or re-exported
 *      path into Electron is refused exactly like a direct one;
 *   2. proves the patch is armed by asking for `electron` itself and
 *      requiring OUR marker back — otherwise a patch that silently failed to
 *      install would report a clean load of a graph that never faced the test;
 *   3. requires each handler's own bundle, one isolated graph per handler, and
 *      prints every outcome as JSON on stdout.
 *
 * The throw lands at EVALUATION time for a hard `import { app } from
 * 'electron'` — precisely the defect A1 removes — while a guarded
 * `require('electron')` inside a function body is never reached and its
 * module loads normally. Nothing here knows which of the two it is looking
 * at; the graph decides.
 *
 * Usage: node headless-load-probe.cjs <manifest.json>
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const MARKER = 'HEADLESS_PROBE_ELECTRON_UNAVAILABLE';

let refused = 0;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron' || request.startsWith('electron/')) {
    refused += 1;
    const err = new Error(`${MARKER}: require('${request}') is unavailable in a headless process`);
    err.code = 'HEADLESS_PROBE_ELECTRON';
    throw err;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const out = { marker: MARKER, patchArmed: false, refused: 0, results: [], fatal: null };

try {
  require('electron');
} catch (err) {
  out.patchArmed = String(err && err.message).includes(MARKER);
}

let manifest = { outdir: '', entries: [] };
try {
  // `path.resolve` so the probe can be run by hand with a relative path; a
  // bare relative specifier would be resolved as a package name instead.
  manifest = JSON.parse(fs.readFileSync(path.resolve(process.argv[2] ?? ''), 'utf8'));
} catch (err) {
  out.fatal = { message: `cannot read manifest: ${String(err && err.message)}` };
}

for (const name of manifest.entries ?? []) {
  // Each handler is a separate output file with its own copy of its graph, so
  // one handler's failure cannot be inherited by the next one.
  const file = path.join(manifest.outdir, `${name}.js`);
  try {
    const loaded = require(file);
    out.results.push({
      module: name,
      ok: true,
      exports: loaded && typeof loaded === 'object' ? Object.keys(loaded).length : 0,
    });
  } catch (err) {
    out.results.push({
      module: name,
      ok: false,
      message: String(err && err.message),
      stack: String(err && err.stack).split('\n').slice(0, 3).join(' | '),
    });
  }
}

out.refused = refused;
process.stdout.write(JSON.stringify(out, null, 2));
process.exit(0);

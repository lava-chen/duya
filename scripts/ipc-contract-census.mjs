#!/usr/bin/env node
// ipc-contract-census.mjs — report every place the renderer↔main IPC
// contract disagrees with itself (plan 583, ISS-06 / ISS-24 / ISS-25).
//
// Why this is a tool and not a one-off grep: the audit's root cause RC-1 is
// that the channel-name contract is hand-maintained in two places with no
// check. Four fully implemented features were unreachable because a handler
// was registered as `session:unarchive` while the renderer invoked
// `db:session:unarchive` — a difference of one prefix, invisible at runtime
// and invisible to esbuild. A grep finds it once; a script makes the whole
// class re-checkable after every change.
//
// Usage:
//   node scripts/ipc-contract-census.mjs            # human report, exit 0
//   node scripts/ipc-contract-census.mjs --strict   # exit 1 on any drift
//
// Exit codes: 0 = clean (or drift reported non-strict), 1 = drift in strict
// mode, 2 = the census could not run.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const strict = process.argv.includes('--strict');

/** Every `.ts` under a directory, excluding tests. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

// `ipcMain.handle('ch', ...)` and `ipcMain.handle(\n  'ch', ...`
const REGISTER = /ipcMain\.handle\(\s*[`'"]?([A-Za-z0-9:_-]+)[`'"]?/g;
// Lazy groups publish handlers through the IpcRegistrar sink, so
// `register('ch', ...)` is a real registration that never touches ipcMain.
const LAZY_REGISTER = /(?<![.\w])register\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
// The `channels: [...]` allowlist of a `registerLazyIpcHandlers({ ... })` group.
// Note lazy-ipc-registry.ts only forwards a handler when its channel appears
// in this list, so a handler registered under a name missing from here is
// silently dropped — declaring it is what makes it reachable.
const LAZY_GROUP = /registerLazyIpcHandlers\(\s*\{[\s\S]*?channels:\s*\[([\s\S]*?)\]/g;
const QUOTED = /[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
// `invoke('ch', ...)` in the preload bridge
const INVOKE = /\.invoke\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;
// Channels the renderer subscribes to rather than invokes.
const LISTEN = /\.on\(\s*[`'"]([A-Za-z0-9:_-]+)[`'"]/g;

function rel(p) {
  return relative(repoRoot, p).split(sep).join('/');
}

let electronFiles;
try {
  electronFiles = tsFiles(join(repoRoot, 'electron'));
} catch (err) {
  process.stderr.write(`ipc-contract-census: cannot read electron/: ${err.message}\n`);
  process.exit(2);
}

const registered = new Map(); // channel -> [locations]
function addRegistration(ch, where) {
  if (!registered.has(ch)) registered.set(ch, []);
  registered.get(ch).push(where);
}

for (const file of electronFiles) {
  const text = readFileSync(file, 'utf8');
  const lineOf = (idx) => text.slice(0, idx).split('\n').length;

  let m;
  REGISTER.lastIndex = 0;
  while ((m = REGISTER.exec(text)) !== null) addRegistration(m[1], `${rel(file)}:${lineOf(m.index)}`);

  LAZY_REGISTER.lastIndex = 0;
  while ((m = LAZY_REGISTER.exec(text)) !== null) {
    addRegistration(m[1], `${rel(file)}:${lineOf(m.index)} (lazy registrar)`);
  }

  LAZY_GROUP.lastIndex = 0;
  while ((m = LAZY_GROUP.exec(text)) !== null) {
    let q;
    QUOTED.lastIndex = 0;
    while ((q = QUOTED.exec(m[1])) !== null) {
      addRegistration(q[1], `${rel(file)}:${lineOf(m.index)} (lazy group allowlist)`);
    }
  }
}

let preloadText;
try {
  preloadText = readFileSync(join(repoRoot, 'electron/preload.ts'), 'utf8');
} catch (err) {
  process.stderr.write(`ipc-contract-census: cannot read electron/preload.ts: ${err.message}\n`);
  process.exit(2);
}

const invoked = new Map();
let m;
INVOKE.lastIndex = 0;
while ((m = INVOKE.exec(preloadText)) !== null) {
  const ch = m[1];
  const line = preloadText.slice(0, m.index).split('\n').length;
  if (!invoked.has(ch)) invoked.set(ch, []);
  invoked.get(ch).push(line);
}

const listened = new Set();
LISTEN.lastIndex = 0;
while ((m = LISTEN.exec(preloadText)) !== null) listened.add(m[1]);

// A channel the renderer can reach that nothing handles. This is the
// ISS-24 class: exposed through `contextBridge`, so the renderer believes it
// exists and every call rejects at runtime.
const unreachable = [...invoked.keys()]
  .filter((ch) => !registered.has(ch))
  .sort();

// Same defect, other direction: a handler nobody can reach. Only report the
// ones whose name looks like a plain `domain:action` (a dynamic or
// prefix-registered handler is legitimately not statically discoverable).
const unconsumed = [...registered.entries()]
  .filter(([ch]) => !invoked.has(ch) && !listened.has(ch))
  .map(([ch, locs]) => ({ ch, locs }))
  .sort((a, b) => a.ch.localeCompare(b.ch));

process.stdout.write(
  `ipc-contract-census: ${registered.size} registered, ${invoked.size} invoked from preload\n\n`,
);

process.stdout.write(`UNREACHABLE — exposed to the renderer, no handler (${unreachable.length})\n`);
for (const ch of unreachable) {
  process.stdout.write(`  ${ch}\n      invoked at electron/preload.ts:${invoked.get(ch).join(',')}\n`);
}

process.stdout.write(`\nUNCONSUMED — handler registered, nothing in preload calls it (${unconsumed.length})\n`);
for (const { ch, locs } of unconsumed) {
  process.stdout.write(`  ${ch}\n      registered at ${locs.join(', ')}\n`);
}

const drift = unreachable.length + unconsumed.length;
if (strict && drift > 0) {
  process.stderr.write(
    `\nipc-contract-census: ${drift} contract drift(s). Every unreachable channel is a ` +
      `feature the renderer can call but the main process will never answer.\n`,
  );
  process.exit(1);
}
process.stdout.write(`\nipc-contract-census: ${drift} drift(s) found.\n`);
process.exit(0);

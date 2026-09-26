#!/usr/bin/env node
/**
 * mac-gate.mjs — plan 572 §7 machine-gate runbook (one command).
 *
 * Automates every §7 checklist item that does not need the Electron
 * UI, against the real helper binary, once the host has the TCC
 * grants. Run it on a macOS 13+ machine from the repo root:
 *
 *   node scripts/mac-gate.mjs            # full auto ladder
 *   node scripts/mac-gate.mjs --no-open  # don't launch TextEdit (gate 2 needs it)
 *
 * What it drives automatically:
 *   [gate1] Finder/Safari/Chrome AX coverage matrix (enumerate counts,
 *           truncated flags, AXManualAccessibility retry for Chromium,
 *           AXSecureField sighting check)
 *   [gate2] injection ladder against a throwaway TextEdit document:
 *           foreground activate → AX setValue + read-back (confirmed)
 *           → pid-scoped keystroke + read-back (CGEventPostToPid rung)
 *   [extra] Secure Input + Screen Recording state dump
 *
 * What stays manual (needs the app UI or a human watching):
 *   recorder three-target session, packaged-app checks ③④⑤,
 *   §8 matrix sign-off.
 *
 * TCC notes (plan 572 §6):
 *   - Dev runs: the grant must go to the process that spawned this
 *     script (Terminal / IDE) — macOS attributes TCC to the
 *     responsible app. Packaged runs: the DUYA bundle.
 *   - Accessibility: Privacy & Security → Accessibility.
 *     Screen Recording: … → Screen Recording (needs app relaunch).
 *     Input Monitoring: … → Input Monitoring.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');

const HELPER = process.platform === 'win32'
  ? path.resolve('resources/ax-helper/bin/ax-helper.exe')
  : path.resolve('resources/ax-helper/bin/ax-helper');

if (process.platform !== 'darwin') {
  console.error('[mac-gate] darwin only.');
  process.exit(3);
}
if (!existsSync(HELPER)) {
  console.error('[mac-gate] helper binary missing — run scripts/build-ax-helper.sh first.');
  process.exit(3);
}

// --- minimal line-protocol client (standalone; not the daemon pipeline) ---

const proc = spawn(HELPER, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiters = new Map();
let nextId = 1;
let ready = null;

proc.stdout.setEncoding('utf8');
let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.ready === true) {
      const r = ready; ready = true; if (r) r();
    } else if (typeof msg.id === 'number' && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

function request(op, extra = {}, timeoutMs = 5000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    proc.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
  });
}

async function untilReady() {
  if (ready === true) return true;
  await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10_000);
    const poll = setInterval(() => {
      if (ready === true) { clearInterval(t2); clearTimeout(t); resolve(true); }
      function t2() { /* named no-op */ }
    }, 50);
    var t2 = () => { clearInterval(poll); };
  });
  return ready === true;
}

// --- report helpers ---

const results = [];
function record(gate, name, pass, detail = '') {
  results.push({ gate, name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  [${gate}] ${name}${detail ? ' — ' + detail : ''}`);
}

function deepLink(pane) {
  const map = {
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    listen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  };
  try {
    execFileSync('open', [map[pane]], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- gate steps ---

async function gate0Permissions() {
  console.log('\n== gate 0: TCC permissions ==');
  const res = await request('permissions');
  if (!res || !res.ok) {
    record('g0', 'helper answers permissions', false, res ? res.error?.code : 'no response');
    return false;
  }
  const p = res.permissions;
  console.log(`  accessibility=${p.accessibility} screen=${p.screen} listen=${p.listen} secureInputPid=${JSON.stringify(p.secureInputPid)}`);
  if (p.accessibility !== 'granted') {
    console.log('  -> Accessibility NOT granted. Grant it to the RESPONSIBLE process of this');
    console.log('     shell (dev: your Terminal/IDE; packaged: the DUYA bundle), then re-run.');
    if (args.has('--open-settings')) deepLink('accessibility');
    record('g0', 'accessibility granted', false, 'required for every AX gate below');
    return false;
  }
  record('g0', 'accessibility granted', true);
  record('g0', 'screen recording granted', p.screen === 'granted', p.screen === 'granted' ? '' : 'window titles + window capture degrade');
  record('g0', 'input monitoring granted', p.listen === 'granted', p.listen === 'granted' ? '' : 'recorder keyboard listening degrades');
  return true;
}

async function gate1Matrix() {
  console.log('\n== gate 1: Finder/Safari/Chrome coverage matrix ==');
  const appsRes = await request('apps');
  const apps = appsRes?.ok ? appsRes.apps : [];
  const byName = (needle) => apps.find((a) => a.name.toLowerCase().includes(needle));

  for (const [label, needle] of [['Finder', 'finder'], ['Safari', 'safari'], ['Chrome', 'chrome']]) {
    const app = byName(needle);
    if (!app) {
      record('g1', `${label}: running`, false, 'not running — launch it once and re-run');
      continue;
    }
    let res = await request('enumerate', { pid: app.pid, maxNodes: 500 });
    let retried = false;
    if (res?.ok && res.reason === 'empty-tree' && needle !== 'finder') {
      // Chromium/WebKit may not have built its tree: AXManualAccessibility
      // recipe (set → wait → one retry). Harmless on non-Chromium targets.
      await request('manualAccessibility', { pid: app.pid });
      await new Promise((r) => setTimeout(r, 300));
      res = await request('enumerate', { pid: app.pid, maxNodes: 500 });
      retried = true;
    }
    if (!res?.ok) {
      record('g1', `${label} (${app.pid}) enumerate`, false, res?.error?.code ?? 'no response');
      continue;
    }
    const n = (res.elements ?? []).length;
    const secure = (res.elements ?? []).some((e) => e.isPassword === true);
    const roles = [...new Set((res.elements ?? []).map((e) => e.role).filter(Boolean))].slice(0, 6).join(',');
    record('g1', `${label} (${app.pid}) tree non-empty`, n > 0, `count=${n} truncated=${res.truncated}${retried ? ' after AXManualAccessibility retry' : ''} roles=[${roles}]`);
    if (secure) {
      record('g1', `${label} AXSecureField flagged`, true, 'password redaction path exercised');
    }
  }
}

async function gate2Injection() {
  console.log('\n== gate 2: injection ladder (TextEdit scratchpad) ==');
  if (noOpen) {
    record('g2', 'skipped', true, '--no-open passed');
    return;
  }
  try {
    execFileSync('open', ['-a', 'TextEdit'], { stdio: 'ignore' });
  } catch {
    record('g2', 'launch TextEdit', false, 'TextEdit unavailable');
    return;
  }
  await new Promise((r) => setTimeout(r, 1_500));

  const appsRes = await request('apps');
  const te = (appsRes?.ok ? appsRes.apps : []).find((a) => a.name === 'TextEdit' || a.name === '文本编辑');
  if (!te) {
    record('g2', 'TextEdit running', false, 'launch it and re-run');
    return;
  }
  // Rung 3 (foreground): activate is what `open` already did.
  const act = await request('activate', { pid: te.pid });
  record('g2', 'foreground activate', act?.ok === true && act.activated === true);

  // Find the text area: enumerate → deepest AXTextArea/AXTextField.
  let handle = null;
  let area = null;
  for (let attempt = 0; attempt < 3 && !handle; attempt++) {
    const res = await request('enumerate', { pid: te.pid, maxNodes: 800, roles: ['AXTextArea', 'AXTextField'] });
    if (res?.ok) {
      area = (res.elements ?? []).find((e) => (e.role === 'AXTextArea' || e.role === 'AXTextField') && e.handle);
      handle = area?.handle ?? null;
    }
    if (!handle) await new Promise((r) => setTimeout(r, 500));
  }
  if (!handle) {
    record('g2', 'AX text area found', false, 'create/open a text document and re-run');
    return;
  }

  // Rung 1 (AX action path): direct value set, then READ BACK — the only
  // driver-verifiable rung (plan 572 D4/D10).
  const marker = `duya gate ${Date.now()}`;
  const set = await request('setValue', { pid: te.pid, handle, value: marker });
  const re = await request('enumerate', { pid: te.pid, maxNodes: 800, roles: ['AXTextArea', 'AXTextField'] });
  const after = (re?.ok ? re.elements : []).find((e) => e.handle === handle);
  const axVerified = set?.ok === true && (after?.value ?? '').includes(marker);
  record('g2', 'rung1 AX setValue + read-back (confirmed)', axVerified, axVerified ? 'value round-tripped' : 'set failed or value not visible');

  // Rung 2 (pid events): post a keystroke (kVK_ANSI_X = 0x07) and see the
  // document grow — CGEventPostToPid keyboard delivery.
  if (axVerified) {
    const key = await request('keyToPid', { pid: te.pid, vk: 0x07, flags: [] });
    await new Promise((r) => setTimeout(r, 300));
    const re2 = await request('enumerate', { pid: te.pid, maxNodes: 800, roles: ['AXTextArea', 'AXTextField'] });
    const after2 = (re2?.ok ? re2.elements : []).find((e) => e.handle === handle);
    record('g2', 'rung2 pid keystroke + read-back', key?.ok === true && (after2?.value ?? '').length > (after?.value ?? '').length, 'CGEventPostToPid');
  }
}

async function extraState() {
  console.log('\n== extra state ==');
  const si = await request('secureInput');
  if (si?.ok) {
    console.log(`  secureInput: enabled=${si.secureInput.enabled} pid=${JSON.stringify(si.secureInput.pid)}`);
  }
  const fg = await request('fg');
  if (fg?.ok && fg.fg) {
    console.log(`  foreground: ${fg.fg.processName} (pid=${fg.fg.pid}, windowId=${fg.fg.windowId}, title=${JSON.stringify(fg.fg.title)})`);
  }
}

// --- main ---

const readyOk = await untilReady();
if (!readyOk) {
  console.error('[mac-gate] helper never became ready.');
  proc.kill();
  process.exit(3);
}

console.log('[mac-gate] plan 572 §7 machine-gate runbook');
const permsOk = await gate0Permissions();
if (permsOk) {
  await gate1Matrix();
  await gate2Injection();
  await extraState();
}

proc.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n[mac-gate] ${results.length - failed.length}/${results.length} checks passed.`);
console.log('[mac-gate] still manual (needs the DUYA app UI): recorder three-target session,');
console.log('[mac-gate] packaged checks ③④⑤, §8 matrix sign-off — see plan 572 §7.');
process.exit(failed.length > 0 ? 1 : 0);

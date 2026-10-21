#!/usr/bin/env node
/**
 * scripts/recorder-smoke.cjs — headless smoke test for the plan 556
 * recorder pipeline (phases 1-3), no Electron required.
 *
 *   hook-worker (uiohook) -> RecorderAggregator -> SessionStore -> converter
 *
 * Answers "does recording still work?" in ~15s without launching the app.
 * The session is written to the PRODUCTION root (~/.duya/recorder) so the
 * recordings tab can list it; delete it there, or with --clean.
 *
 *   node scripts/recorder-smoke.cjs              # record N ms, convert
 *   REC_MS=30000 node scripts/recorder-smoke.cjs # longer window
 *   node scripts/recorder-smoke.cjs --clean      # delete past smoke-* sessions
 *
 * NOT covered here (needs the real app): the UIA probe enrichment, the
 * recorder:* IPC handlers, the badge, and the renderer UI.
 *
 * Run AFTER `npm run build:agent` (converter dist) and a computer-use
 * build, since it loads both from dist.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFileSync } = require('node:child_process');

const REC = require('../packages/computer-use/dist/recorder/index.js');
const { convertEventsToWorkflow } = require('../packages/agent/dist/modes/workflow/converter.js');
const { stringify } = require('yaml');

const DURATION_MS = Number(process.env.REC_MS || 15000);
const WORKER = path.join(__dirname, '..', 'packages', 'computer-use', 'dist', 'recorder', 'hook-worker-entry.js');
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PREFIX = 'smoke-';
const root = REC.getDefaultRecorderRootDir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delete previous smoke sessions so the listing stays honest. */
async function clean() {
  let n = 0;
  for (const s of await REC.listSessions(root)) {
    if (s.sessionId.startsWith(PREFIX)) {
      await REC.deleteSession(root, s.sessionId);
      n++;
    }
  }
  return n;
}

/**
 * Foreground window via the same user32 P/Invoke the focus tracker uses.
 * The script goes through a temp .ps1 + `-File` rather than `-Command`
 * because passing nested quotes through argv mangles the C# member
 * definition; a file has no quoting layer to lose.
 */
function foregroundApp() {
  const tmp = path.join(os.tmpdir(), `duya-fg-${process.pid}.ps1`);
  const body = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    // NOTE: the C# member definition MUST use double quotes around the DLL
    // name (`DllImport("user32.dll")`). Single quotes make it a char
    // literal and Add-Type fails with "too many characters in character
    // literal" — see the callout in the doc block above.
    '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);\' -Name WinFg -Namespace Native -PassThru',
    '$h = $t::GetForegroundWindow()',
    'if ($h -eq [IntPtr]::Zero) { return }',
    '$procId = 0',
    '$null = $t::GetWindowThreadProcessId($h, [ref]$procId)',
    '$p = Get-Process -Id $procId -ErrorAction SilentlyContinue',
    '"{0}`t{1}`t{2}`t{3}" -f $h, $procId, $p.ProcessName, $p.MainWindowTitle',
  ].join('\r\n');
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    const out = execFileSync(
      PS_EXE,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { encoding: 'utf8', timeout: 30000 },
    );
    const line = (out.trim().split(/\r?\n/).pop() || '').trim();
    const parts = line.split('\t');
    if (parts.length < 4 || !parts[2]) throw new Error('no foreground window resolved');
    return {
      name: parts[2],
      title: parts.slice(3).join('\t'),
      processName: parts[2],
      pid: Number(parts[1]) || 0,
    };
  } catch (e) {
    console.log(`[warn] foreground query failed (${e.message.slice(0, 120)}) — using placeholder`);
    return { name: 'smoke-app', title: '', processName: 'smoke-app', pid: 0 };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/**
 * Synthesize a semantic input event without disturbing the desktop: three
 * wheel notches down followed by three up, so the focused view ends exactly
 * where it started while the hook sees real wheel events (which the
 * aggregator debounces into `scroll`). A bare modifier key would NOT do:
 * the aggregator drops modifier-only presses, so a passive user would look
 * like a broken pipeline.
 */
function synthWheel() {
  const tmp = path.join(os.tmpdir(), `duya-wheel-${process.pid}.ps1`);
  const body = [
    '$t = Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);\' -Name Ms -Namespace Native -PassThru',
    // MOUSEEVENTF_WHEEL = 0x0800, WHEEL_DELTA = 120.
    'for ($i=0; $i -lt 3; $i++) { $t::mouse_event(0x0800,0,0,120,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }',
    'Start-Sleep -Milliseconds 700',
    'for ($i=0; $i -lt 3; $i++) { $t::mouse_event(0x0800,0,0,4294967176,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }',
  ].join('\r\n');
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    execFileSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
      encoding: 'utf8',
      timeout: 30000,
    });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

(async () => {
  if (process.argv.includes('--clean')) {
    console.log(`deleted ${await clean()} prior ${PREFIX}* session(s)`);
    return;
  }

  console.log(`root      : ${root}`);
  if (!fs.existsSync(WORKER)) {
    console.error(`\nFATAL: worker entry missing:\n  ${WORKER}\nBuild it first (npm run build / tsc in packages/computer-use).`);
    process.exit(1);
  }

  await clean();
  const sessionId = PREFIX + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const app = foregroundApp();
  console.log(`foreground: ${app.processName}`);
  console.log(`sessionId : ${sessionId}\n`);

  const store = new REC.SessionStore(root, sessionId);
  await store.start();
  const agg = new REC.RecorderAggregator();
  const ctx = { app };

  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let raw = 0;
  let fed = 0;
  let written = 0;
  let buf = '';
  const appendAll = async (evs) => {
    for (const e of evs) {
      await store.append(e);
      written++;
    }
  };

  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      raw++;
      if (line.includes('"heartbeat"')) continue; // service parity
      const ev = REC.parseWorkerLine(line);
      if (!ev) continue;
      fed++;
      appendAll(agg.feed(ev, ctx)).catch((e) => console.log(`[append err] ${e.message}`));
    }
  });

  const pollTimer = setInterval(() => void appendAll(agg.poll(ctx)).catch(() => {}), 1000);

  console.log(`recording ${DURATION_MS}ms — use the computer normally now\n`);
  await sleep(Math.max(1200, Math.round(DURATION_MS / 3)));
  const synth = synthWheel();
  await sleep(Math.max(1200, DURATION_MS - Math.round(DURATION_MS / 3)));

  clearInterval(pollTimer);
  try { child.kill(); } catch { /* already gone */ }
  await appendAll(agg.finish(ctx));
  const summary = await store.end();

  console.log('--- capture ---');
  console.log(`worker lines        : ${raw}`);
  console.log(`fed to aggregator   : ${fed}`);
  console.log(`semantic events     : ${written}`);
  console.log(`summary.eventCount  : ${summary.eventCount}`);
  console.log(`summary.apps        : ${JSON.stringify(summary.apps)}`);
  console.log(`session dir         : ${path.join(root, 'sessions', sessionId)}`);
  if (!synth) console.log('[warn] synthetic input failed — a passive window proves nothing');
  const loaded = await REC.loadSession(root, sessionId);
  const kinds = loaded.events.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
  console.log(`reloaded            : ${loaded.events.length} (dropped ${loaded.dropped.length})`);
  console.log(`kinds               : ${JSON.stringify(kinds)}`);

  console.log('\n--- convert (phase 3) ---');
  const res = convertEventsToWorkflow(loaded.events);
  console.log(`ok       : ${res.ok}`);
  console.log(`errors   : ${JSON.stringify(res.errors)}`);
  console.log(`warnings : ${JSON.stringify(res.warnings)}`);
  if (res.def) {
    const yaml = stringify(res.def);
    const outFile = path.join(__dirname, '..', '_recorder-smoke.yaml');
    fs.writeFileSync(outFile, yaml, 'utf8');
    console.log(`def      : ${res.def.name}  phases=${(res.def.phases || []).length}`);
    console.log(`yaml     : ${outFile}`);
  }

  const pass = fed > 0 && written > 0 && res.ok;
  console.log(`\n${pass ? 'PASS' : 'FAIL'} — capture+aggregate+convert ${pass ? 'working' : 'did NOT produce a convertible session'}`);
  process.exit(pass ? 0 : 1);
})();

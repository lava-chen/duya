/**
 * Headless end-to-end smoke test for `duya tui` (round 2: tool-calling turn).
 *
 * Drives the REAL command path inside a real pty (node-pty):
 *   node packages/cli/dist/index.js tui
 *
 * Usage: node .tui-pty-smoke.mjs [prompt]
 *
 * Improvements over round 1:
 *  - node-pty on Windows decodes the pty stream with the ANSI codepage, so
 *    UTF-8 terminal output arrives mojibake'd. Re-encode via iconv-lite
 *    (gbk) to recover the real bytes for a faithful log.
 *  - If the turn stalls (permission picker on screen), approve with 'y'.
 *  - Notes are flushed before streams are closed.
 */
import pty from 'node-pty';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');

const REPO = 'E:/Projects/duya';
const TAG = process.argv[3] || 'run';
const RAW_LOG = `E:/tmp/tui-pty-raw-${TAG}.log`;
const SCREEN_LOG = `E:/tmp/tui-final-screen-${TAG}.txt`;
const EVENTS_LOG = `E:/tmp/tui-pty-events-${TAG}.log`;
const PROMPT = process.argv[2] || '当前目录下有哪些文件？简单列一下';

const raw = fs.createWriteStream(RAW_LOG);
const events = fs.createWriteStream(EVENTS_LOG);
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
const note = (msg) => events.write(`[${el()}s] ${msg}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recover UTF-8 text from node-pty's cp936-decoded string. */
function fixMojibake(s) {
  try {
    const bytes = iconv.encode(s, 'gbk');
    const utf8 = bytes.toString('utf8');
    // Sanity: if the fixup produced replacement chars everywhere, keep raw.
    const bad = (utf8.match(/\uFFFD/g) || []).length;
    return bad > utf8.length / 4 ? s : utf8;
  } catch {
    return s;
  }
}

const proc = pty.spawn(process.execPath, ['packages/cli/dist/index.js', 'tui'], {
  cwd: REPO,
  env: { ...process.env, TERM: 'xterm-256color', TERM_PROGRAM: 'duya-smoke' },
  cols: 120,
  rows: 40,
});

let buf = '';
let lastDataAt = Date.now();
const markers = [];

const MARKER_PATTERNS = [
  ['alt-screen', /\x1b\[\?1049h/],
  ['session-notice', /session [0-9a-f-]{8}/i],
  ['run-refused', /run refused/i],
  ['run-failed', /Run .* failed/i],
  ['stream-error', /event stream error/i],
  ['host-unreachable', /not reachable|Host failed to start/i],
  ['unknown-command', /Unknown command/i],
  ['tool-started', /[\u25ce\u2022]\s*\w+\(/],
  ['permission', /permission|allow|Approve|\[y\/a\/n\]/i],
  ['error-line', /\berror\b/i],
];

proc.onData((d) => {
  const fixed = fixMojibake(d);
  buf += fixed;
  lastDataAt = Date.now();
  raw.write(fixed);
  for (const [name, re] of MARKER_PATTERNS) {
    if (re.test(fixed) && !markers.includes(name)) {
      markers.push(name);
      note(`marker: ${name}`);
    }
  }
});

proc.onExit(({ exitCode, signal }) => {
  note(`pty exit: code=${exitCode} signal=${signal}`);
});

/** Strip ANSI escapes, collapse to visible text lines. */
function visibleText(s) {
  return s
    .replace(/\x1b\[\?1049[hl]/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][A-B0-9]/g, '')
    .replace(/\r/g, '\n');
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  note(`TIMEOUT waiting for: ${label}`);
  return false;
}

(async () => {
  note(`spawned duya tui in pty (120x40); prompt="${PROMPT}"`);

  // --- Phase 1: TUI startup ---------------------------------------------
  const started = await waitFor(
    () => markers.includes('alt-screen') && markers.includes('session-notice'),
    45000,
    'TUI startup (alt screen + session notice)',
  );
  note(`startup ok=${started}; markers: ${markers.join(',') || '(none)'}`);
  if (!started) {
    fs.writeFileSync(SCREEN_LOG, visibleText(buf).slice(-4000));
    note('ABORT: TUI never came up');
    try { proc.kill(); } catch {}
    await sleep(1000);
    raw.end(); events.end();
    return;
  }
  await sleep(3000); // let the first full render settle

  // --- Phase 2: submit the prompt ---------------------------------------
  note(`submitting prompt: ${PROMPT}`);
  proc.write(PROMPT);
  await sleep(800);
  proc.write('\r');

  // --- Phase 3: wait for the turn to settle ------------------------------
  const submitAt = Date.now();
  const bufLenAtSubmit = buf.length;
  let sawOutput = false;
  let approved = false;
  let settled = false;
  while (Date.now() - submitAt < 210000) {
    await sleep(500);
    if (buf.length > bufLenAtSubmit + 40) sawOutput = true;
    const quietMs = Date.now() - lastDataAt;
    if (sawOutput && quietMs > 9000) { settled = true; break; }
    // Stalled for a while with no quiet? Probably a permission picker.
    if (!approved && Date.now() - submitAt > 60000 && quietMs > 5000) {
      note('stalled >60s — sending "y" to approve a possible permission prompt');
      proc.write('y');
      await sleep(400);
      proc.write('\r');
      approved = true;
      lastDataAt = Date.now();
    }
  }
  note(settled
    ? `turn settled after ${((Date.now() - submitAt) / 1000).toFixed(1)}s`
    : 'turn did NOT settle within budget');
  note(`markers at settle: ${markers.join(',') || '(none)'}`);

  fs.writeFileSync(SCREEN_LOG, visibleText(buf).slice(-6000));

  // --- Phase 4: /exit -----------------------------------------------------
  note('sending /exit');
  proc.write('/exit');
  await sleep(600);
  proc.write('\r');
  await sleep(4000);
  try { proc.kill(); } catch {}
  await sleep(1500);

  note(`final markers: ${markers.join(',') || '(none)'}`);
  note(`raw log bytes: ${fs.statSync(RAW_LOG).size}`);
  raw.end();
  events.end();
})().catch((err) => {
  note(`driver error: ${err?.stack || err}`);
  try { proc.kill(); } catch {}
  raw.end(); events.end();
});

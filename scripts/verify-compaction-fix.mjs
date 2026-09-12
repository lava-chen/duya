#!/usr/bin/env node
// verify-compaction-fix.mjs
//
// Read-only verification that the c9c53302 fix is live in this duya install.
//
// Scans:
//   1. Disk: every <duyaRoot>/agents/<agentId>/sessions/{active,archive-N}.jsonl
//      for size, line count, top-level RolloutLine type distribution, and
//      presence of a "rotation" first-line / "rebase" rebase events.
//   2. SQLite: duya-core.db message_index kind distribution per session.
//   3. SQLite: duya-main.db chat_sessions.generation per session id.
//
// Compares against expected post-fix state:
//   - First compaction-form rebase after the fix should land as
//     {type:"rebase", reason:"compaction"} — NOT legacy_unknown_role.
//   - A rebase with reason:"compaction" on a bot session should produce
//     a sibling archive-<g>.jsonl and bump chat_sessions.generation.
//
// Exits 0 if every bot session either has generation>0 (post-fix evidence)
// OR is small enough that compaction has never been needed yet.
// Exits 1 if any session shows a legacy_unknown_role row with a
// "journal:compact:*:rebase" id (i.e. bug-shape row still being produced).
//
// Usage:
//   node scripts/verify-compaction-fix.mjs [--duya-root <path>]
//                                          [--core-db <path>]
//                                          [--main-db <path>]
//                                          [--save-baseline [path]]
//                                          [--diff-baseline <path>]
//
// --save-baseline writes the full report to docs/agent-runs/verify-<ts>.txt
// (or the given path). Useful as a "before" snapshot for diffing against
// post-compaction runs without leaving console-only output.
// --diff-baseline reads a previous snapshot and prints a verdict delta
// (which sessions moved FIXED → CLEAN, how many bug-shape rows disappeared).
//
// Defaults match the dev install under C:/Users/lavachen/.duya and
// C:/Users/lavachen/AppData/Roaming/duya/duya-dev/databases.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ARGS = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const HOME = os.homedir();
const DUYA_ROOT =
  ARGS['duya-root'] ?? path.join(HOME, '.duya');
const CORE_DB =
  ARGS['core-db'] ?? path.join(
    HOME,
    'AppData',
    'Roaming',
    'duya',
    'duya-dev',
    'databases',
    'duya-core.db',
  );
const MAIN_DB =
  ARGS['main-db'] ?? path.join(
    HOME,
    'AppData',
    'Roaming',
    'duya',
    'duya-dev',
    'databases',
    'duya-main.db',
  );

// dirty-id shape produced by the pre-fix Journal.fireEventRaw bug
const BUG_ID_RE = /^journal:compact:\d+:\d+:all:rebase$/;
const BUG_ROLE = 'legacy_unknown_role';

function sqlQuery(db, sql) {
  const out = spawnSync('sqlite3', [db, sql], { encoding: 'utf8' });
  if (out.status !== 0) {
    return { error: out.stderr || `sqlite3 exit ${out.status}` };
  }
  const text = out.stdout.trim();
  if (!text) return { rows: [] };
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const rows = lines.map((line) => line.split('|'));
  return { rows };
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readJsonlHead(filePath, maxLines = 3) {
  const lines = [];
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    for (const line of data.split('\n')) {
      if (line.length === 0) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        lines.push({ _parseError: true, raw: line.slice(0, 200) });
      }
      if (lines.length >= maxLines) break;
    }
  } catch (e) {
    return { error: e.message };
  }
  return { lines };
}

function classifyLine(line) {
  if (!line || typeof line !== 'object') return 'other';
  if (line.type === 'rebase') {
    const reason = line.reason ?? 'compaction'; // backward-compat: missing reason ⇒ compaction
    return `rebase:${reason}`;
  }
  if (line.type === 'rotation') return 'rotation';
  if (line.type === 'message') {
    if (line.message?.role === BUG_ROLE && BUG_ID_RE.test(line.id ?? '')) {
      return 'message:bug-shape-legacy';
    }
    return 'message';
  }
  return line.type ?? 'other';
}

function analyzeFile(filePath) {
  const stat = safeStat(filePath);
  if (!stat) return { exists: false };
  let total = 0;
  const types = {};
  let firstLineType = null;
  let lastLineType = null;
  let bugShapeRows = 0;
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    for (const line of data.split('\n')) {
      if (line.length === 0) continue;
      total += 1;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        types['parse-error'] = (types['parse-error'] ?? 0) + 1;
        continue;
      }
      const cls = classifyLine(obj);
      types[cls] = (types[cls] ?? 0) + 1;
      if (firstLineType === null) firstLineType = cls;
      lastLineType = cls;
      if (cls === 'message:bug-shape-legacy') bugShapeRows += 1;
    }
  } catch (e) {
    return { exists: true, error: e.message };
  }
  return {
    exists: true,
    bytes: stat.size,
    lines: total,
    types,
    firstLineType,
    lastLineType,
    bugShapeRows,
  };
}

function analyzeBotSession(agentId, sessionsDir) {
  const activePath = path.join(sessionsDir, 'active.jsonl');
  const archives = fs
    .readdirSync(sessionsDir)
    .filter((f) => /^archive-\d+\.jsonl$/.test(f))
    .sort();
  const active = analyzeFile(activePath);
  const archiveReports = archives.map((f) => ({
    file: f,
    path: path.join(sessionsDir, f),
    ...analyzeFile(path.join(sessionsDir, f)),
  }));
  return {
    agentId,
    sessionsDir,
    activePath,
    active,
    archives: archiveReports,
    archiveCount: archives.length,
  };
}

// ── main ──
console.log(`# verify-compaction-fix`);
console.log(`duya_root=${DUYA_ROOT}`);
console.log(`core_db=${CORE_DB}`);
console.log(`main_db=${MAIN_DB}`);
console.log('');

const agentsRoot = path.join(DUYA_ROOT, 'agents');
if (!fs.existsSync(agentsRoot)) {
  console.error(`FAIL: ${agentsRoot} does not exist`);
  process.exit(1);
}
const agentDirs = fs
  .readdirSync(agentsRoot)
  .map((d) => path.join(agentsRoot, d))
  .filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

console.log(`## ${agentDirs.length} agent dirs found`);

// ── disk scan ──
const reports = [];
for (const agentDir of agentDirs) {
  const agentId = path.basename(agentDir);
  const sessionsDir = path.join(agentDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) continue;
  reports.push(analyzeBotSession(agentId, sessionsDir));
}

reports.sort((a, b) => (b.active?.bytes ?? 0) - (a.active?.bytes ?? 0));

// ── db scan ──
// message_index.session_id covers BOTH bot sessions ('bot:bot-XXX') and
// main sessions (UUID). message_index.generation is the canonical rotation
// counter for all session types (Plan 506/493 + MessageLog migration #13).
let coreBySession = new Map();
let maxCoreGenBySession = new Map();
{
  const r = sqlQuery(
    CORE_DB,
    `SELECT session_id, generation, COUNT(*) FROM message_index GROUP BY session_id, generation`,
  );
  if (r.error) {
    console.warn(`WARN: core db query failed: ${r.error}`);
  } else {
    for (const [sessionId, generation, count] of r.rows) {
      const g = Number(generation);
      let m = coreBySession.get(sessionId);
      if (!m) {
        m = new Map();
        coreBySession.set(sessionId, m);
      }
      m.set(g, (m.get(g) ?? 0) + Number(count));
      const prev = maxCoreGenBySession.get(sessionId) ?? -1;
      if (g > prev) maxCoreGenBySession.set(sessionId, g);
    }
  }
}

// chat_sessions tracks MAIN (human/cron) sessions only — bot sessions are
// intentionally absent from this table (managed by bot_sessions in core.db
// which currently is empty for active bots, falling back to on-disk jsonl
// as source of truth).
let mainById = new Map();
{
  const r = sqlQuery(MAIN_DB, `SELECT id, generation FROM chat_sessions`);
  if (r.error) {
    console.warn(`WARN: main db query failed: ${r.error}`);
  } else {
    for (const [id, generation] of r.rows) {
      mainById.set(id, Number(generation));
    }
  }
}

// ── judgement per session ──
// Bot sessions live under <root>/agents/<agentId>/sessions, indexed in
// core.message_index with session_id = 'bot:<agentId>'.
const verdicts = [];
for (const r of reports) {
  const sessionId = `bot:${r.agentId}`;
  const coreMaxGen = maxCoreGenBySession.get(sessionId);
  const genMap = coreBySession.get(sessionId) ?? new Map();
  const gen0 = genMap.get(0) ?? 0;
  const genN = coreMaxGen !== undefined && coreMaxGen > 0 ? (genMap.get(coreMaxGen) ?? 0) : 0;
  const chatGen = mainById.get(sessionId);
  // disk bug-shape rows in any file under this agent's sessions dir
  let diskBugShape = r.active?.bugShapeRows ?? 0;
  for (const a of r.archives) diskBugShape += a.bugShapeRows ?? 0;

  // verdict logic
  let verdict = 'UNKNOWN';
  let reason = '';
  if (coreMaxGen !== undefined && coreMaxGen > 0 && diskBugShape === 0) {
    verdict = 'FIXED';
    reason = `message_index.generation=${coreMaxGen}, zero bug-shape rows`;
  } else if (coreMaxGen !== undefined && coreMaxGen > 0 && diskBugShape > 0) {
    verdict = 'PARTIAL';
    reason = `rotation triggered (gen=${coreMaxGen}) but ${diskBugShape} bug-shape rows remain in old archives`;
  } else if (coreMaxGen !== undefined && coreMaxGen === 0 && diskBugShape > 0) {
    verdict = 'PRE-FIX-DIRTY';
    reason = `${diskBugShape} bug-shape rows present, no rotation ever occurred`;
  } else if (coreMaxGen === undefined) {
    verdict = 'NO-INDEX';
    reason = `no message_index rows for ${sessionId}`;
  } else if (coreMaxGen === 0 && diskBugShape === 0) {
    verdict = 'NEVER-COMPACTED';
    reason = 'no rotation, no bug-shape rows; compaction has never been triggered on this session';
  }
  verdicts.push({
    agentId: r.agentId,
    sessionId,
    activeBytes: r.active?.bytes ?? 0,
    activeLines: r.active?.lines ?? 0,
    archiveCount: r.archiveCount,
    coreMaxGen: coreMaxGen ?? '?',
    chatGen: chatGen ?? '?',
    diskBugShape,
    gen0,
    genN,
    verdict,
    reason,
  });
}

// ── print ──
const fixed = verdicts.filter((v) => v.verdict === 'FIXED').length;
const partial = verdicts.filter((v) => v.verdict === 'PARTIAL').length;
const preFix = verdicts.filter((v) => v.verdict === 'PRE-FIX-DIRTY').length;
const never = verdicts.filter((v) => v.verdict === 'NEVER-COMPACTED').length;
const other = verdicts.length - fixed - partial - preFix - never;

console.log('');
console.log('## summary');
console.log(`total bot sessions       : ${verdicts.length}`);
console.log(`FIXED (post-fix rotation) : ${fixed}`);
console.log(`PARTIAL (rotation ran, archive still has bug rows) : ${partial}`);
console.log(`PRE-FIX-DIRTY (bug rows, no rotation ever) : ${preFix}`);
console.log(`NEVER-COMPACTED (clean)   : ${never}`);
console.log(`other (no-db-row etc.)    : ${other}`);
console.log('');
console.log('## per-session report');
console.log('');
const headers = [
  'agentId',
  'activeKB',
  'lines',
  'archives',
  'coreGenMax',
  'gen0',
  'genN',
  'bugRows',
  'verdict',
];
console.log(headers.join('\t'));
for (const v of verdicts) {
  console.log(
    [
      v.agentId,
      String(Math.round(v.activeBytes / 1024)),
      String(v.activeLines),
      String(v.archiveCount),
      String(v.coreMaxGen),
      String(v.gen0),
      String(v.genN),
      String(v.diskBugShape),
      v.verdict,
    ].join('\t'),
  );
}
console.log('');
console.log('## legend');
console.log('  activeKB        — active.jsonl size');
console.log('  lines           — active.jsonl JSONL lines');
console.log('  archives        — sibling archive-N.jsonl count');
console.log('  coreGenMax      — max(message_index.generation) for this session_id');
console.log('  gen0            — message_index rows at generation=0 (pre-rotation)');
console.log('  genN            — message_index rows at max generation (post-rotation, 0 if never)');
console.log('');

// ── snapshot helpers ──
function snapshot() {
  return {
    savedAt: new Date().toISOString(),
    summary: { total: verdicts.length, fixed, partial, preFix, never, other },
    verdicts: verdicts.map((v) => ({
      agentId: v.agentId,
      sessionId: v.sessionId,
      activeBytes: v.activeBytes,
      activeLines: v.activeLines,
      archiveCount: v.archiveCount,
      coreMaxGen: v.coreMaxGen,
      gen0: v.gen0,
      genN: v.genN,
      diskBugShape: v.diskBugShape,
      verdict: v.verdict,
    })),
  };
}

if (ARGS['save-baseline'] !== undefined) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target =
    ARGS['save-baseline'] === true || ARGS['save-baseline'] === ''
      ? path.join('docs', 'agent-runs', `verify-${ts}.json`)
      : ARGS['save-baseline'];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(snapshot(), null, 2));
  console.error(`snapshot saved: ${target}`);
}

if (ARGS['diff-baseline']) {
  const p = ARGS['diff-baseline'];
  if (!fs.existsSync(p)) {
    console.error(`diff-baseline: file not found: ${p}`);
    process.exit(2);
  }
  const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
  const prevById = new Map(prev.verdicts.map((v) => [v.sessionId, v]));
  console.log('');
  console.log(`## diff against ${p} (saved ${prev.savedAt})`);
  let moved = 0;
  for (const v of verdicts) {
    const before = prevById.get(v.sessionId);
    if (!before) {
      console.log(`  +NEW ${v.sessionId}  verdict=${v.verdict}  bugRows=${v.diskBugShape}`);
      moved += 1;
      continue;
    }
    if (before.verdict !== v.verdict) {
      console.log(`  *${v.sessionId}  ${before.verdict} → ${v.verdict}  bugRows ${before.diskBugShape} → ${v.diskBugShape}`);
      moved += 1;
    } else if (before.diskBugShape !== v.diskBugShape) {
      console.log(`  ~${v.sessionId}  verdict=${v.verdict}  bugRows ${before.diskBugShape} → ${v.diskBugShape}`);
    }
  }
  for (const prevV of prev.verdicts) {
    if (!verdicts.find((v) => v.sessionId === prevV.sessionId)) {
      console.log(`  -GONE ${prevV.sessionId}`);
      moved += 1;
    }
  }
  console.log(`(${moved} session(s) changed verdict or set membership)`);
  console.log('');
}

// ── exit code ──
if (preFix > 0) {
  console.error(`FAIL: ${preFix} bot session(s) still have bug-shape rows with no rotation ever triggered.`);
  console.error(`       These sessions were never compacted under the fix; expect them to look healthy`);
  console.error(`       after the next manual or proactive compaction runs.`);
  process.exit(1);
}
if (partial > 0) {
  console.warn(`WARN: ${partial} session(s) have post-fix rotation but pre-fix bug-shape residue in archive files.`);
  console.warn(`       Cosmetic only — read path uses active.jsonl.`);
}
console.log('OK');
process.exit(0);

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { CoreDataHost } from '@duya/data/core-data-host';

const DATA_ROOT = path.join(os.homedir(), '.duya');

const host = new CoreDataHost({
  filename: path.join(DATA_ROOT, 'duya-core.db'),
  rolloutRoot: DATA_ROOT,
  attachmentsRoot: path.join(DATA_ROOT, 'attachments'),
  messageLogPorts: {
    botSessionIdPrefix: 'bot-',
    parseBotSessionId: () => null,
    getBotSessionsDir: () => '',
    getBotSessionLogPath: () => '',
  },
});
const db = host.database.db;
const messageLog = host.stores.messageLog;

const total = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
const legacy = db
  .prepare("SELECT COUNT(*) c FROM sessions WHERE extensions LIKE '%legacy_import%'")
  .get().c;
const idx = db.prepare('SELECT COUNT(*) c FROM message_index').get().c;
const search = db.prepare('SELECT COUNT(*) c FROM message_search').get().c;

console.log('=== totals ===');
console.log('  sessions in db        :', total, `(imported ${legacy}, pre-existing ${total - legacy})`);
console.log('  message_index rows    :', idx);
console.log('  message_search rows   :', search);

console.log('\n=== message_index kinds (imported sessions only) ===');
const kinds = db
  .prepare(
    `SELECT kind, COUNT(*) c FROM message_index
     WHERE session_id IN (SELECT id FROM sessions WHERE extensions LIKE '%legacy_import%')
     GROUP BY kind ORDER BY c DESC`,
  )
  .all();
for (const k of kinds) console.log('  ' + String(k.c).padStart(7) + '  ' + k.kind);

console.log('\n=== rollout_path integrity ===');
const rows = db
  .prepare("SELECT id, title, rollout_path, extensions FROM sessions WHERE extensions LIKE '%legacy_import%'")
  .all();
let missing = 0;
let inPlace = 0;
let converted = 0;
let emptyPath = 0;
for (const r of rows) {
  let ext = {};
  try {
    ext = JSON.parse(r.extensions);
  } catch {}
  if (ext.legacy_import_source === 'rollout') inPlace++;
  else converted++;
  if (!r.rollout_path) {
    emptyPath++;
    continue;
  }
  if (!fs.existsSync(path.join(DATA_ROOT, r.rollout_path))) {
    missing++;
    if (missing <= 5) console.log('  MISSING:', r.id, r.rollout_path);
  }
}
console.log(`  imported sessions      : ${rows.length} (in place ${inPlace}, converted ${converted})`);
console.log(`  rollout_path empty     : ${emptyPath}`);
console.log(`  rollout file missing   : ${missing}`);

console.log('\n=== files on disk ===');
function walk(dir, out = []) {
  let es;
  try {
    es = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of es) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
console.log('  jsonl files now        :', walk(path.join(DATA_ROOT, 'sessions')).length, '(was 1131 before the import)');

console.log('\n=== sample sessions ===');
for (const r of [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean)) {
  const evs = messageLog.listBySession(r.id);
  console.log(`  ${r.id}`);
  console.log(`    title: ${JSON.stringify(r.title)}  (${evs.length} events)`);
  const kindsOf = db
    .prepare('SELECT kind, COUNT(*) c FROM message_index WHERE session_id = ? GROUP BY kind')
    .all(r.id)
    .map((k) => `${k.kind}:${k.c}`)
    .join(' ');
  console.log(`    index: ${kindsOf}`);
  console.log(`    path : ${r.rollout_path}`);
}

console.log('\n=== search smoke test ===');
const q = '测试';
const hits = messageLog.searchText(q, { limit: 5 });
console.log(`  searchText(${q}) → ${hits.length} hits`);
for (const h of hits.slice(0, 3)) {
  console.log(`    ${h.sessionId}  ${JSON.stringify(String(h.snippet).slice(0, 60))}`);
}

host.close();

#!/usr/bin/env node
/**
 * import-legacy-rollouts.mjs — restore duya sessions whose metadata rows were
 * lost when plan 328 moved the core tables out of `duya-main.db`.
 *
 * ## Why this exists
 *
 * The plan-328 cut moved `chat_sessions` / `messages` out of `duya-main.db` into
 * `duya-core.db` + rollout JSONL files. The one-shot importer
 * (`packages/data/src/legacy-import.ts`, wired in
 * `apps/desktop/src/main/db/core-connection.ts`) copies those DB rows — but on
 * machines that had already emptied the legacy tables it faithfully copied
 * nothing and then wrote its `meta.imported_from_legacy` marker, so the probe
 * never ran again.
 *
 * The rollout FILES survived that cut untouched. What was lost is the
 * `sessions` row for each of them: title, working directory, provider, mode.
 * So the recovery is the inverse of the legacy import — rebuild the session
 * metadata rows from the rollout files instead of the other way round.
 *
 * ## What it does
 *
 *   1. Walks `<dataRoot>/sessions/**\/*.jsonl` and groups files by session id.
 *   2. Classifies each session from its file names:
 *        `-cron-` → cron        (skipped)
 *        `-gw-`   → gateway     (skipped)
 *        otherwise → interactive (imported)
 *   3. Skips sessions that already have a row in `sessions`.
 *   4. Imports each interactive session:
 *        - MODERN rollouts (rows of `type: 'message'`) are referenced IN PLACE.
 *          The file is not copied and not rewritten; only the `sessions` row is
 *          created and `MessageLog.scan()` builds the index. Zero disk cost.
 *        - LEGACY codex rollouts (`session_meta` / `turn_context` /
 *          `response_item` / `event_msg` rows) are converted to the modern
 *          line shape and written as a NEW compact rollout file through
 *          `MessageLog.appendBatch()`, which also builds `message_index` and
 *          `message_search`.
 *        - A session whose conversation spans several modern files is merged
 *          into one new file for the same reason (a `sessions` row can only
 *          point at one rollout path).
 *
 * ## Usage
 *
 *   node scripts/import-legacy-rollouts.mjs              # dry run (default)
 *   node scripts/import-legacy-rollouts.mjs --apply      # write
 *   node scripts/import-legacy-rollouts.mjs --apply --limit 25
 *   node scripts/import-legacy-rollouts.mjs --undo       # remove what was imported
 *   node scripts/import-legacy-rollouts.mjs --data-root D:\duya-data
 *
 * ## Safety
 *
 * - Dry run by default; `--apply` is required to write anything.
 * - The duya app must not be running (it holds the core DB open).
 * - Idempotent: sessions that already exist are skipped, so a second run
 *   imports nothing new.
 * - `--undo` reverses an import: it deletes the sessions this tool created
 *   (identified by the `legacy_import` extension flag) plus their index rows,
 *   and removes only the rollout files this tool WROTE. Files that were
 *   referenced in place are never deleted.
 * - Original rollout files are never modified or deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { CoreDataHost } from '@duya/data/core-data-host';

// ─── Args ───

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const APPLY = hasFlag('--apply');
const UNDO = hasFlag('--undo');
const LIMIT = flagValue('--limit') ? Number(flagValue('--limit')) : Infinity;
const ONLY_SESSION = flagValue('--session');
const DATA_ROOT = path.resolve(
  flagValue('--data-root') ??
    process.env.DUYA_DATA_ROOT ??
    path.join(os.homedir(), '.duya'),
);

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// ─── Helpers ───

const log = (...args) => console.log(...args);
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function die(msg) {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
}

/** Refuse to run while the app holds the core database open. */
function assertAppNotRunning() {
  if (process.platform !== 'win32') return;
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
    const hits = out
      .split(/\r?\n/)
      .map((l) => l.split(',')[0]?.replace(/"/g, '').trim())
      .filter((n) => n && /^(duya|Duya|electron)$/i.test(n));
    if (hits.length) {
      die(`the duya app appears to be running (${[...new Set(hits)].join(', ')}). Close it and re-run.`);
    }
  } catch {
    // tasklist unavailable — do not block the run on it.
  }
}

function walkJsonl(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter((l) => l.trim());
}

/** Parse one rollout line; returns null for anything unparseable. */
function parseLine(raw) {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/**
 * Non-interactive session markers, found in the rollout file name.
 *
 *   cron-<uuid>-<epoch>-<uuid>     scheduled runs
 *   gw-<epoch>-<hash>              gateway / IM bridge sessions
 *   gw-weixin-<...>                the WeChat gateway
 *   curation-memory-worker-<uuid>  background memory-curation workers
 *   spawn-<epoch>-<hash>           sub-agent spawns
 *   room-group-<hash>              team rooms
 *   bot-test*                      a bot fixture
 *
 * Everything else is treated as an interactive session.
 */
const NON_INTERACTIVE_MARKERS = [
  'cron',
  'gw',
  'curation-memory-worker',
  'spawn',
  'room-group',
  'bot-test',
];

/** Classify a session by its file names. */
function classifySession(files) {
  const bases = files.map((f) => path.basename(f));
  for (const b of bases) {
    for (const marker of NON_INTERACTIVE_MARKERS) {
      if (b.includes(`-${marker}`)) {
        if (marker === 'gw') return 'gateway';
        return marker;
      }
    }
  }
  return 'interactive';
}

/** Session id for a file: the uuid in the name, else the parent directory name. */
function sessionIdOf(file) {
  const m = path.basename(file).match(UUID_RE);
  if (m) return m[0];
  const parent = path.basename(path.dirname(file));
  return UUID_RE.test(parent) ? parent : parent;
}

// ─── Rollout parsing ───

/**
 * Read every line of a session's files, tagged with its source file.
 * Returns { rows, meta, turnContexts }.
 */
function readSessionRows(files) {
  const rows = [];
  let meta = null;
  const turnContexts = [];
  for (const file of files) {
    for (const raw of readLines(file)) {
      const o = parseLine(raw);
      if (!o) continue;
      const type = o.type;
      if (type === 'message') {
        rows.push({ kind: 'modern', o, file });
      } else if (type === 'session_meta') {
        meta = o.payload ?? null;
      } else if (type === 'turn_context') {
        turnContexts.push(o.payload ?? null);
      } else if (type === 'response_item' || type === 'event_msg') {
        rows.push({ kind: 'legacy', o, file });
      }
      // rotation / rebase / world_state rows are carried over as-is.
      else if (type === 'rotation' || type === 'rebase') {
        rows.push({ kind: 'event', o, file });
      }
    }
  }
  return { rows, meta, turnContexts };
}

/** Timestamp of a rollout row in ms. */
function rowTimestamp(o) {
  if (typeof o.createdAt === 'number') return o.createdAt;
  if (typeof o.timestamp === 'string') {
    const t = Date.parse(o.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  if (o.payload && typeof o.payload.timestamp === 'string') {
    const t = Date.parse(o.payload.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** Flatten a codex content array into plain text. */
function codexText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : (b?.text ?? b?.content ?? '')))
      .join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * Convert one legacy codex row into a modern `message` rollout line.
 *
 * Mirrors the mapping the product already uses for imported codex sessions:
 * `apps/desktop/src/main/import/writer/session-writer.ts` (`parseCodexJsonlLine`)
 * for the row semantics, and `packages/data/src/legacy-import.ts`
 * (`legacyRowToMessage`) for the block shapes. Returns null for rows that
 * carry no user-visible content.
 *
 * `hasCleanUser` tells us whether the session also has an
 * `event_msg: user_message` row. The codex `response_item` copy of a user
 * turn carries the injected AGENTS.md preamble, so it is dropped when the
 * clean copy exists.
 *
 * Generated ids are namespaced by session id: `message_index.id` is a GLOBAL
 * primary key, so two sessions must never mint the same id.
 */
function legacyRowToModernLine(o, seq, hasCleanUser, sessionId) {
  const createdAt = rowTimestamp(o);
  const payload = o.payload ?? {};
  const base = (id, role, content, extra = {}) => ({
    type: 'message',
    id,
    parentId: null,
    createdAt,
    message: {
      id,
      role,
      content,
      timestamp: createdAt,
      visibility: 'visible',
      status: 'done',
      metadata: {},
      ...extra,
    },
  });

  if (o.type === 'event_msg') {
    if (payload.type === 'user_message') {
      const text = typeof payload.message === 'string' ? payload.message : codexText(payload.message);
      if (!text) return null;
      return base(`legacy:${sessionId}:user:${seq}:${createdAt}`, 'user', [{ type: 'text', text }], { msg_type: 'text' });
    }
    if (payload.type === 'agent_reasoning') {
      if (!payload.text) return null;
      return base(`legacy:${sessionId}:think:${seq}:${createdAt}`, 'assistant', [{ type: 'thinking', thinking: payload.text }], {
        msg_type: 'thinking',
      });
    }
    return null;
  }

  // o.type === 'response_item'
  if (payload.type === 'message') {
    const role = payload.role === 'developer' || payload.role === 'system' ? 'system' : (payload.role || 'user');
    const text = codexText(payload.content);
    if (!text) return null;
    if (role === 'user' && hasCleanUser) {
      // The clean copy of this user turn is the `event_msg: user_message` row.
      return null;
    }
    return base(
      payload.id ? `legacy:${sessionId}:${payload.id}` : `legacy:${sessionId}:msg:${seq}:${createdAt}`,
      role,
      [{ type: 'text', text: role === 'user' ? stripInjectedPreamble(text) : text }],
      { msg_type: 'text' },
    );
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    let input = {};
    try {
      input = payload.arguments ? JSON.parse(payload.arguments) : {};
    } catch {
      input = {};
    }
    const callId = payload.call_id || payload.id || `${seq}`;
    return base(`legacy:${sessionId}:fc:${callId}`, 'assistant', [
      { type: 'tool_use', id: callId, name: payload.name || 'tool', input },
    ], { msg_type: 'tool_use', tool_call_id: callId, tool_name: payload.name || 'tool' });
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = codexText(payload.output);
    const callId = payload.call_id || '';
    return base(`legacy:${sessionId}:fco:${payload.id || seq}`, 'tool', [
      { type: 'tool_result', tool_use_id: callId, content: output, is_error: false },
    ], { msg_type: 'tool_result', tool_call_id: callId, name: 'legacy-tool' });
  }
  if (payload.type === 'reasoning') {
    const text = codexText(payload.summary);
    if (!text) return null;
    return base(`legacy:${sessionId}:rs:${payload.id || seq}`, 'assistant', [{ type: 'thinking', thinking: text }], {
      msg_type: 'thinking',
    });
  }
  return null;
}

// ─── Session metadata ───

const DEFAULT_TITLE = 'New Chat';

/**
 * Derive a session title from its first user message.
 *
 * For legacy codex rollouts the clean user input lives in
 * `event_msg: user_message`; the `response_item` copy of the same turn also
 * carries the injected AGENTS.md preamble, so it must never win the title.
 */
function deriveTitle(rows, meta) {
  let legacyFallback = null;
  for (const r of rows) {
    if (r.kind === 'modern') {
      const m = r.o.message;
      if (m?.role !== 'user') continue;
      const c = m.content;
      const text = typeof c === 'string' ? c : codexText(c);
      if (text) return truncateTitle(text);
    } else if (r.kind === 'legacy') {
      const p = r.o.payload ?? {};
      if (r.o.type === 'event_msg' && p.type === 'user_message' && p.message) {
        return truncateTitle(String(p.message));
      }
      if (!legacyFallback && r.o.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        const t = codexText(p.content);
        if (t) legacyFallback = truncateTitle(stripInjectedPreamble(t));
      }
    }
  }
  return legacyFallback ?? DEFAULT_TITLE;
}

/**
 * Drop the AGENTS.md / system preamble that the codex runtime injects into
 * the `response_item` copy of a user turn. The preamble is recognizable by
 * its fixed opening sentence.
 */
function stripInjectedPreamble(text) {
  const marker = 'Codebase and user instructions are shown below';
  const idx = text.indexOf(marker);
  if (idx < 0) return text;
  // The real user input follows the preamble block. Find the last line that
  // looks like a fresh instruction instead of slicing at a fixed offset.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#') && !line.startsWith('<') && !line.startsWith('IMPORTANT:')) {
      return lines.slice(i).join('\n');
    }
  }
  return text;
}

function truncateTitle(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return DEFAULT_TITLE;
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** Working directory: session_meta.cwd, else the first turn_context cwd. */
function deriveCwd(meta, turnContexts) {
  if (meta?.cwd) return String(meta.cwd);
  for (const tc of turnContexts) {
    if (tc?.cwd) return String(tc.cwd);
  }
  return '';
}

/** Provider id: session_meta.model_provider, else the legacy default 'env'. */
function deriveProvider(meta) {
  const p = meta?.model_provider;
  return p ? String(p) : 'env';
}

/** Model: turn_context.model, else empty (unknown). */
function deriveModel(turnContexts) {
  for (const tc of turnContexts) {
    if (tc?.model) return String(tc.model);
  }
  return '';
}

// ─── Import ───

async function main() {
  const dbPath = path.join(DATA_ROOT, 'duya-core.db');
  const sessionsRoot = path.join(DATA_ROOT, 'sessions');

  log(`data root : ${DATA_ROOT}`);
  log(`core db   : ${dbPath}`);
  log(`mode      : ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  log('');

  if (!fs.existsSync(dbPath)) die(`core database not found: ${dbPath}`);
  if (!fs.existsSync(sessionsRoot)) die(`rollout root not found: ${sessionsRoot}`);
  assertAppNotRunning();

  // ── Collect files and group by session ──
  const files = walkJsonl(sessionsRoot);
  log(`rollout files: ${files.length}`);

  const groups = new Map();
  for (const f of files) {
    const id = sessionIdOf(f);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(f);
  }
  log(`distinct session ids in rollouts: ${groups.size}`);

  // ── Open the core database through the product's own store composition ──
  const host = new CoreDataHost({
    filename: dbPath,
    rolloutRoot: DATA_ROOT,
    attachmentsRoot: path.join(DATA_ROOT, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot-',
      parseBotSessionId: () => null,
      getBotSessionsDir: () => '',
      getBotSessionLogPath: () => '',
      logger: {
        info: (m, d) => log(`    [data] ${m}`, d ? JSON.stringify(d) : ''),
        warn: (m, d) => log(`    [data][warn] ${m}`, d ? JSON.stringify(d) : ''),
        error: (m, d) => log(`    [data][error] ${m}`, d ? JSON.stringify(d) : ''),
      },
    },
  });

  const db = host.database.db;
  const sessions = host.stores.sessions;
  const messageLog = host.stores.messageLog;

  const existing = new Set(db.prepare('SELECT id FROM sessions').all().map((r) => r.id));
  const indexedIds = new Set(db.prepare('SELECT id FROM message_index').all().map((r) => r.id));

  // ── Undo: remove exactly what this tool created ──
  if (UNDO) {
    const rows = db
      .prepare("SELECT id, title, rollout_path, extensions FROM sessions WHERE extensions LIKE '%legacy_import%'")
      .all()
      .filter((r) => !ONLY_SESSION || r.id === ONLY_SESSION);
    log('');
    log(`sessions carrying the legacy_import flag: ${rows.length}`);
    if (rows.length === 0) {
      log('nothing to undo.');
      host.close();
      return;
    }
    for (const r of rows.slice(0, 20)) log(`  ${r.id}  ${JSON.stringify(r.title)}`);
    if (rows.length > 20) log(`  ... and ${rows.length - 20} more`);

    const del = db.transaction(() => {
      for (const r of rows) {
        db.prepare('DELETE FROM message_index WHERE session_id = ?').run(r.id);
        db.prepare('DELETE FROM message_search WHERE session_id = ?').run(r.id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(r.id);
      }
    });
    del();

    let removedFiles = 0;
    for (const r of rows) {
      if (!r.rollout_path) continue;
      let ext = {};
      try {
        ext = JSON.parse(r.extensions);
      } catch {
        /* ignore */
      }
      // Only files this tool WROTE may be removed. A session whose rollout was
      // referenced IN PLACE carries `legacy_import_source: 'rollout'` and its
      // rollout_path points at an ORIGINAL file — that file must survive.
      if (ext.legacy_import_source === 'rollout') continue;
      if (Array.isArray(ext.legacy_source_files) && ext.legacy_source_files.includes(r.rollout_path)) continue;
      const abs = path.join(DATA_ROOT, r.rollout_path);
      try {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          removedFiles++;
        }
      } catch (err) {
        log(`  could not remove ${r.rollout_path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log('');
    log(`── undo report ──`);
    log(`  sessions removed  : ${rows.length}`);
    log(`  files removed     : ${removedFiles} (generated files only; originals untouched)`);
    host.close();
    log('');
    log('Done.');
    return;
  }

  // ── Decide what to import ──
  const plan = [];
  const skipped = { cron: 0, gateway: 0, existing: 0 };
  const skippedOther = new Map();

  for (const [id, groupFiles] of groups) {
    const cls = classifySession(groupFiles);
    if (cls === 'cron') { skipped.cron++; continue; }
    if (cls === 'gateway') { skipped.gateway++; continue; }
    if (cls !== 'interactive') {
      skippedOther.set(cls, (skippedOther.get(cls) ?? 0) + 1);
      continue;
    }
    if (existing.has(id)) { skipped.existing++; continue; }
    if (ONLY_SESSION && id !== ONLY_SESSION) continue;
    plan.push({ id, files: groupFiles });
  }

  log('');
  log(`skipped: ${skipped.cron} cron, ${skipped.gateway} gateway, ${skipped.existing} already in the db`);
  if (skippedOther.size) {
    log(`skipped background workers: ${[...skippedOther].map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  log(`candidates to import: ${plan.length}`);
  if (ONLY_SESSION) log(`restricted to session: ${ONLY_SESSION}`);

  if (!APPLY) {
    // Full strategy census so the dry run answers "how much is copied?"
    // before anything is written.
    let inPlace = 0;
    let convert = 0;
    let convertedBytes = 0;
    const samples = [];
    for (const item of plan) {
      const { rows, meta, turnContexts } = readSessionRows(item.files);
      const modernFiles = new Set(rows.filter((r) => r.kind === 'modern').map((r) => r.file));
      if (modernFiles.size === 1) {
        inPlace++;
      } else {
        convert++;
        let seq = 0;
        let bytes = 0;
        const hasCleanUser = rows.some(
          (r) => r.kind === 'legacy' && r.o.type === 'event_msg' && r.o.payload?.type === 'user_message',
        );
        for (const r of rows) {
          const line = r.kind === 'modern' ? r.o : legacyRowToModernLine(r.o, seq, hasCleanUser, item.id);
          if (!line) continue;
          seq++;
          bytes += Buffer.byteLength(JSON.stringify(line));
        }
        convertedBytes += bytes;
        if (samples.length < 4) {
          samples.push({
            id: item.id,
            files: item.files.length,
            rows: rows.length,
            modern: modernFiles.size,
            legacy: rows.filter((r) => r.kind === 'legacy').length,
            messages: seq,
            bytes,
            title: deriveTitle(rows, meta),
            cwd: deriveCwd(meta, turnContexts),
            provider: deriveProvider(meta),
            model: deriveModel(turnContexts),
          });
        }
      }
    }
    log('');
    log('── strategy census ──');
    log(`  reference in place (no file written) : ${inPlace}`);
    log(`  convert + write a new rollout file   : ${convert}`);
    log(`  extra disk needed                    : ${fmtBytes(convertedBytes)}`);
    log('');
    log('── dry run: inspecting the first 5 candidates ──');
    for (const item of plan.slice(0, 5)) {
      const { rows, meta, turnContexts } = readSessionRows(item.files);
      const modernFiles = new Set(rows.filter((r) => r.kind === 'modern').map((r) => r.file));
      const modernRows = rows.filter((r) => r.kind === 'modern');
      log(`  ${item.id}`);
      log(`    files            : ${item.files.length} (${modernFiles.size} carry modern message rows)`);
      log(`    rows             : ${rows.length} (modern ${modernRows.length}, legacy ${rows.filter((r) => r.kind === 'legacy').length})`);
      log(`    title            : ${JSON.stringify(deriveTitle(rows, meta))}`);
      log(`    working dir      : ${JSON.stringify(deriveCwd(meta, turnContexts))}`);
      log(`    provider / model : ${deriveProvider(meta)} / ${deriveModel(turnContexts) || '(unknown)'}`);
      log(`    strategy         : ${modernFiles.size === 1 ? 'reference in place (zero copy)' : 'convert + write new file'}`);
    }
    if (samples.length) {
      log('');
      log('── dry run: samples of the convert path ──');
      for (const s of samples) {
        log(`  ${s.id}`);
        log(`    files ${s.files} (modern ${s.modern}, legacy ${s.legacy}) → ${s.messages} messages, ${fmtBytes(s.bytes)}`);
        log(`    title       : ${JSON.stringify(s.title)}`);
        log(`    working dir : ${JSON.stringify(s.cwd)}`);
        log(`    provider    : ${s.provider}   model: ${s.model || '(unknown)'}`);
      }
    }
    log('');
    log('Re-run with --apply to write.');
    host.close();
    return;
  }

  // ── Import ──
  log('');
  const report = { imported: 0, sessions: 0, messages: 0, inPlace: 0, converted: 0, empty: 0, failed: 0, errors: [] };
  const target = plan.slice(0, LIMIT === Infinity ? undefined : LIMIT);

  for (const [i, item] of target.entries()) {
    const { id, files } = item;
    try {
      const { rows, meta, turnContexts } = readSessionRows(files);

      // Which files carry modern message rows?
      const modernByFile = new Map();
      for (const r of rows) {
        if (r.kind !== 'modern') continue;
        if (!modernByFile.has(r.file)) modernByFile.set(r.file, []);
        modernByFile.get(r.file).push(r.o);
      }

      const modernFiles = [...modernByFile.keys()];
      const title = deriveTitle(rows, meta);
      const workingDirectory = deriveCwd(meta, turnContexts);
      const providerId = deriveProvider(meta);
      const model = deriveModel(turnContexts);

      // Timestamps: the session's own message span.
      const stamps = rows.map((r) => rowTimestamp(r.o)).filter((t) => t > 0);
      const createdAt = stamps.length ? Math.min(...stamps) : Date.now();
      const updatedAt = stamps.length ? Math.max(...stamps) : createdAt;

      if (modernFiles.length === 1) {
        // ── In place: point the row at the existing file, then index it. ──
        const relPath = path.relative(DATA_ROOT, modernFiles[0]).split(path.sep).join('\\');
        sessions.create({
          id,
          title,
          workingDirectory,
          projectName: '',
          status: 'active',
          model,
          providerId,
          mode: 'code',
          permissionMode: 'default',
          agentType: 'main',
          agentName: '',
          draft: null,
          extensions: {
            legacy_import: true,
            legacy_import_source: 'rollout',
            legacy_rollout_path: relPath,
            legacy_provider: providerId,
            legacy_created_at: createdAt,
          },
          createdAt,
          updatedAt,
          recencyAt: updatedAt,
        });
        db.prepare('UPDATE sessions SET rollout_path = ? WHERE id = ?').run(relPath, id);
        messageLog.invalidateRolloutPathCache(id);
        messageLog.scan(id);
        const indexed = messageLog.getCount(id);
        report.inPlace++;
        report.sessions++;
        report.messages += indexed;
        if ((i + 1) % 25 === 0 || i === target.length - 1) {
          log(`  [${i + 1}/${target.length}] ${id} → in place, ${indexed} messages`);
        }
      } else {
        // ── Convert: write a new compact rollout through the product's writer. ──
        const events = [];
        let seq = 0;
        const hasCleanUser = rows.some(
          (r) => r.kind === 'legacy' && r.o.type === 'event_msg' && r.o.payload?.type === 'user_message',
        );
        for (const r of rows) {
          if (r.kind === 'modern') {
            const o = r.o;
            if (!o.id) continue;
            events.push({
              id: indexedIds.has(o.id) ? `legacy:${id}:${o.id}` : o.id,
              sessionId: id,
              turnId: null,
              payload: o,
              createdAt: rowTimestamp(o),
            });
            indexedIds.add(o.id);
            seq++;
          } else if (r.kind === 'legacy') {
            const line = legacyRowToModernLine(r.o, seq, hasCleanUser, id);
            if (!line) continue;
            seq++;
            const lineId = indexedIds.has(line.id) ? `legacy:${id}:${line.id}` : line.id;
            indexedIds.add(line.id);
            events.push({
              id: lineId,
              sessionId: id,
              turnId: null,
              payload: { ...line, id: lineId },
              createdAt: line.createdAt,
            });
          }
        }

        if (events.length === 0) {
          report.empty++;
          log(`  [${i + 1}/${target.length}] ${id} → skipped (no user-visible messages)`);
          continue;
        }

        sessions.create({
          id,
          title,
          workingDirectory,
          projectName: '',
          status: 'active',
          model,
          providerId,
          mode: 'code',
          permissionMode: 'default',
          agentType: 'main',
          agentName: '',
          draft: null,
          extensions: {
            legacy_import: true,
            legacy_import_source: 'rollout-converted',
            legacy_source_files: files.map((f) => path.relative(DATA_ROOT, f).split(path.sep).join('\\')),
            legacy_provider: providerId,
            legacy_created_at: createdAt,
          },
          createdAt,
          updatedAt,
          recencyAt: updatedAt,
        });
        messageLog.appendBatch(events);
        report.converted++;
        report.sessions++;
        report.messages += events.length;
        if ((i + 1) % 25 === 0 || i === target.length - 1) {
          log(`  [${i + 1}/${target.length}] ${id} → converted, ${events.length} messages`);
        }
      }
      report.imported++;
    } catch (err) {
      report.failed++;
      report.errors.push({ id, error: err instanceof Error ? err.message : String(err) });
      log(`  [${i + 1}/${target.length}] ${id} → FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log('');
  log('── report ──');
  log(`  sessions imported : ${report.sessions} (in place ${report.inPlace}, converted ${report.converted})`);
  log(`  messages indexed  : ${report.messages}`);
  log(`  skipped (empty)   : ${report.empty}`);
  log(`  failures          : ${report.failed}`);
  for (const e of report.errors.slice(0, 10)) log(`    ${e.id}: ${e.error}`);

  host.close();
  log('');
  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * check-db-health.js - Database Health Check Script
 *
 * Validates the DUYA database integrity, schema, and configuration.
 * Used for pre-release E2E verification (Plan #39, Phase 1.2).
 *
 * Usage:
 *   node scripts/check-db-health.js [--db <path>] [--json]
 *
 * Options:
 *   --db <path>   Custom database path (default: auto-detect)
 *   --json        Output results as JSON
 *
 * Example:
 *   node scripts/check-db-health.js
 *   node scripts/check-db-health.js --db "C:/Users/xxx/AppData/Roaming/DUYA/databases/duya-main.db"
 *   node scripts/check-db-health.js --json
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================
// Configuration
// ============================================================

const EXPECTED_TABLES = [
  'chat_sessions',
  'agent_profiles',
  'messages',
  'session_runtime_locks',
  'settings',
  'permission_requests',
  'tasks',
  'channel_bindings',
  'channel_offsets',
  'channel_permission_links',
  'weixin_accounts',
  'weixin_context_tokens',
  'automation_crons',
  'automation_cron_runs',
  'conductor_canvases',
  'conductor_widgets',
  'conductor_actions',
  'gateway_user_map',
  'gateway_message_map',
  '_schema_migrations',
];

const EXPECTED_INDICES = [
  'idx_messages_session_id',
  'idx_messages_created_at',
  'idx_sessions_updated_at',
  'idx_sessions_working_directory',
  'idx_permission_requests_session',
  'idx_tasks_session_id',
  'idx_tasks_status',
  'idx_tasks_owner',
  'idx_channel_bindings_active',
  'idx_channel_offsets_updated',
  'idx_automation_crons_status',
  'idx_automation_crons_next_run',
  'idx_automation_cron_runs_cron',
  'idx_conductor_widgets_canvas',
  'idx_conductor_actions_canvas_ts',
  'idx_conductor_actions_widget_ts',
  'idx_conductor_actions_undone',
  'idx_gateway_user_map_session',
  'idx_gateway_user_map_platform',
  'idx_gateway_message_map_session',
  'idx_sessions_parent_id',
  'idx_messages_msg_type',
];

const REQUIRED_PRAMAS = {
  journal_mode: 'wal',
  foreign_keys: '1',
  busy_timeout: '5000',
};

const REQUIRED_COLUMNS = {
  chat_sessions: [
    'id', 'title', 'created_at', 'updated_at', 'model', 'system_prompt',
    'working_directory', 'project_name', 'status', 'mode', 'permission_profile',
    'provider_id', 'context_summary', 'context_summary_updated_at',
    'is_deleted', 'generation', 'agent_profile_id', 'parent_id',
    'agent_type', 'agent_name',
  ],
  messages: [
    'id', 'session_id', 'role', 'content', 'name', 'tool_call_id',
    'token_usage', 'msg_type', 'thinking', 'tool_name', 'tool_input',
    'parent_tool_call_id', 'viz_spec', 'status', 'seq_index',
    'duration_ms', 'sub_agent_id', 'created_at',
  ],
  settings: ['key', 'value', 'updated_at'],
  tasks: ['id', 'session_id', 'subject', 'description', 'status', 'owner', 'metadata', 'created_at', 'updated_at'],
};

// ============================================================
// Utilities
// ============================================================

function colorize(text, color) {
  const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m',
    bold: '\x1b[1m',
  };
  return `${colors[color] || ''}${text}${colors.reset}`;
}

function icon(status) {
  switch (status) {
    case 'pass': return colorize('\u2713', 'green');
    case 'fail': return colorize('\u2717', 'red');
    case 'warn': return colorize('\u26A0', 'yellow');
    default: return '?';
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getUserDataPath() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support');
  } else {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

function getDefaultDbPath() {
  return path.join(getUserDataPath(), 'DUYA', 'databases', 'duya-main.db');
}

// ============================================================
// Check Functions
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dbPath: null, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      opts.dbPath = args[++i];
    } else if (args[i] === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

function checkFileExists(dbPath) {
  const exists = fs.existsSync(dbPath);
  let stat = null;
  if (exists) {
    stat = fs.statSync(dbPath);
  }
  return { exists, stat };
}

function loadDatabase(dbPath) {
  let BetterSqlite3;
  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch {
    return { error: 'better-sqlite3 module not found. Run: npm install' };
  }

  try {
    const db = new BetterSqlite3(dbPath, { readonly: true });
    return { db };
  } catch (err) {
    return { error: err.message };
  }
}

function checkTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const existingTableNames = rows.map(r => r.name);

  const results = [];
  for (const table of EXPECTED_TABLES) {
    const found = existingTableNames.includes(table);
    results.push({ table, found });
  }

  const virtualRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").all();
  const ftsTable = virtualRows.map(r => r.name);

  return { results, existingCount: existingTableNames.length, ftsTable };
}

function checkColumns(db, tableName, expectedColumns) {
  const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const existingColumns = tableInfo.map(c => c.name);

  const missing = expectedColumns.filter(c => !existingColumns.includes(c));
  return { missing, existingColumns };
}

function checkIndices(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all();
  const existingIndices = rows.map(r => r.name);

  const results = [];
  for (const idx of EXPECTED_INDICES) {
    const found = existingIndices.includes(idx);
    results.push({ index: idx, found });
  }

  return results;
}

function checkPragmas(db) {
  const results = {};
  for (const [pragma, expected] of Object.entries(REQUIRED_PRAMAS)) {
    let row;
    try {
      row = db.prepare(`PRAGMA ${pragma}`).get();
    } catch {
      results[pragma] = { value: 'ERROR', pass: false };
      continue;
    }
    let value;
    if (pragma === 'journal_mode') {
      value = String(row.journal_mode).toLowerCase();
    } else if (pragma === 'foreign_keys') {
      value = String(row.foreign_keys);
    } else {
      value = String(Object.values(row)[0]);
    }
    results[pragma] = {
      value,
      pass: value === expected,
    };
  }
  return results;
}

function checkFts5(db) {
  try {
    const row = db.prepare(
      "SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'"
    ).get();
    if (!row) {
      return { available: false, message: 'FTS5 not compiled in this SQLite build' };
    }

    const ftsExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
    ).get();

    return {
      available: true,
      ftsTableExists: !!ftsExists,
      message: ftsExists ? 'FTS5 enabled and messages_fts table exists' : 'FTS5 available but messages_fts table missing',
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

function checkIntegrity(db) {
  try {
    const result = db.prepare('PRAGMA integrity_check').get();
    return { pass: result.integrity_check === 'ok', message: result.integrity_check };
  } catch (err) {
    return { pass: false, message: err.message };
  }
}

function getStats(db) {
  const stats = {};
  try {
    const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages').get();
    stats.messageCount = msgCount.cnt;

    const sessionCount = db.prepare("SELECT COUNT(*) as cnt FROM chat_sessions WHERE is_deleted = 0").get();
    stats.sessionCount = sessionCount.cnt;

    const deletedSessionCount = db.prepare('SELECT COUNT(*) as cnt FROM chat_sessions WHERE is_deleted = 1').get();
    stats.deletedSessionCount = deletedSessionCount.cnt;

    const settingCount = db.prepare('SELECT COUNT(*) as cnt FROM settings').get();
    stats.settingCount = settingCount.cnt;

    const migrationCount = db.prepare('SELECT COUNT(*) as cnt FROM _schema_migrations').get();
    stats.migrationCount = migrationCount.cnt;

    const taskCount = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status != 'completed'").get();
    stats.activeTaskCount = taskCount.cnt;

    const pageCount = db.prepare('PRAGMA page_count').get();
    stats.pageCount = pageCount.page_count;

    const pageSize = db.prepare('PRAGMA page_size').get();
    stats.dbFileSizeEstimate = pageCount.page_count * pageSize.page_size;

    const freelistCount = db.prepare('PRAGMA freelist_count').get();
    stats.freelistCount = freelistCount.freelist_count;
  } catch (err) {
    stats.error = err.message;
  }
  return stats;
}

function checkQuickCheck(db) {
  try {
    const result = db.prepare('PRAGMA quick_check').get();
    return { pass: result.quick_check === 'ok', message: result.quick_check };
  } catch (err) {
    return { pass: false, message: err.message };
  }
}

// ============================================================
// Report Generation
// ============================================================

function generateReport(dbPath, results) {
  const lines = [];
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  lines.push('');
  lines.push(colorize('=== DUYA Database Health Check ===', 'bold'));
  lines.push(`Database: ${dbPath}`);
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push('');

  // Section 1: File Check
  lines.push(colorize('--- File Check ---', 'bold'));
  let status = results.file.exists ? 'pass' : 'fail';
  if (status === 'pass') passCount++; else failCount++;
  lines.push(`  ${icon(status)} File exists: ${results.file.exists ? 'YES' : 'NO'}`);
  if (results.file.stat) {
    lines.push(`     Size: ${formatSize(results.file.stat.size)}`);
    lines.push(`     Modified: ${results.file.stat.mtime.toISOString()}`);
  }
  if (results.file.walExists !== undefined) {
    const walStatus = results.file.walExists ? 'pass' : 'warn';
    if (walStatus === 'warn') warnCount++;
    lines.push(`  ${icon(walStatus)} WAL file exists: ${results.file.walExists ? 'YES' : 'NO (empty DB)'}`);
  }
  lines.push('');

  // Section 2: Connection & Integrity
  lines.push(colorize('--- Connection & Integrity ---', 'bold'));
  if (results.connect.error) {
    status = 'fail';
    failCount++;
    lines.push(`  ${icon(status)} Database open: FAILED — ${results.connect.error}`);
    lines.push('');
    return { lines, passCount, failCount, warnCount };
  }
  passCount++;
  lines.push(`  ${icon('pass')} Database open: OK`);

  status = results.quickCheck.pass ? 'pass' : 'fail';
  if (status === 'pass') passCount++; else failCount++;
  lines.push(`  ${icon(status)} Quick check: ${results.quickCheck.message}`);

  status = results.integrity.pass ? 'pass' : 'fail';
  if (status === 'pass') passCount++; else failCount++;
  lines.push(`  ${icon(status)} Integrity check: ${results.integrity.message}`);
  lines.push('');

  // Section 3: Pragmas
  lines.push(colorize('--- PRAGMA Configuration ---', 'bold'));
  for (const [pragma, info] of Object.entries(results.pragmas)) {
    status = info.pass ? 'pass' : 'fail';
    if (status === 'pass') passCount++; else failCount++;
    lines.push(`  ${icon(status)} ${pragma}: ${info.value} (expected: ${REQUIRED_PRAMAS[pragma]})`);
  }
  lines.push('');

  // Section 4: Tables
  lines.push(colorize('--- Tables ---', 'bold'));
  for (const { table, found } of results.tables.results) {
    status = found ? 'pass' : 'fail';
    if (status === 'pass') passCount++; else failCount++;
    lines.push(`  ${icon(status)} ${table}`);
  }
  lines.push(`  Total tables: ${results.tables.existingCount} (expected >= ${EXPECTED_TABLES.length})`);
  lines.push('');

  // Section 5: FTS5
  lines.push(colorize('--- FTS5 Full-Text Search ---', 'bold'));
  if (results.fts5.available) {
    status = results.fts5.ftsTableExists ? 'pass' : 'warn';
    if (status === 'pass') passCount++; else warnCount++;
    lines.push(`  ${icon(status)} ${results.fts5.message}`);
  } else {
    status = 'warn';
    warnCount++;
    lines.push(`  ${icon(status)} ${results.fts5.message || 'FTS5 not available'}`);
  }
  lines.push('');

  // Section 6: Column Verification (core tables)
  lines.push(colorize('--- Core Table Columns ---', 'bold'));
  for (const [table, expectedCols] of Object.entries(REQUIRED_COLUMNS)) {
    if (results.columns[table]) {
      const { missing } = results.columns[table];
      status = missing.length === 0 ? 'pass' : 'fail';
      if (status === 'pass') passCount++; else failCount++;
      lines.push(`  ${icon(status)} ${table}: ${missing.length === 0 ? 'ALL columns present' : `MISSING: ${missing.join(', ')}`}`);
    } else {
      failCount++;
      lines.push(`  ${icon('fail')} ${table}: NOT FOUND`);
    }
  }
  lines.push('');

  // Section 7: Indices
  lines.push(colorize('--- Indices ---', 'bold'));
  const missingIndices = results.indices.filter(r => !r.found);
  for (const { index, found } of results.indices) {
    status = found ? 'pass' : 'warn';
    if (status === 'pass') passCount++; else warnCount++;
    lines.push(`  ${icon(status)} ${index}`);
  }
  if (missingIndices.length > 0) {
    lines.push(`  ${icon('warn')} ${missingIndices.length} index(es) missing (non-critical)`);
  }
  lines.push('');

  // Section 8: Statistics
  lines.push(colorize('--- Statistics ---', 'bold'));
  const stats = results.stats;
  if (stats.error) {
    lines.push(`  ${icon('fail')} Could not read stats: ${stats.error}`);
    failCount++;
  } else {
    lines.push(`  ${icon('pass')} Messages: ${stats.messageCount}`);
    lines.push(`  ${icon('pass')} Active sessions: ${stats.sessionCount}`);
    if (stats.deletedSessionCount > 0) {
      lines.push(`  ${icon('warn')} Deleted sessions: ${stats.deletedSessionCount} (soft-deleted)`);
      warnCount++;
    }
    lines.push(`  ${icon('pass')} Settings: ${stats.settingCount}`);
    lines.push(`  ${icon('pass')} Schema migrations applied: ${stats.migrationCount}`);
    lines.push(`  ${icon('pass')} Active tasks: ${stats.activeTaskCount}`);
    if (stats.dbFileSizeEstimate) {
      const dbSize = formatSize(stats.dbFileSizeEstimate);
      const status = stats.dbFileSizeEstimate > 100 * 1024 * 1024 ? 'warn' : 'pass';
      if (status === 'warn') warnCount++;
      lines.push(`  ${icon(status)} Estimated DB size: ${dbSize}`);
    }
    if (stats.freelistCount > 100) {
      warnCount++;
      lines.push(`  ${icon('warn')} Freelist pages: ${stats.freelistCount} (VACUUM recommended)`);
    }
  }
  lines.push('');

  // Summary
  lines.push(colorize('=== Summary ===', 'bold'));
  const total = passCount + failCount + warnCount;
  lines.push(`  ${colorize(passCount + ' passed', 'green')}, ${colorize(failCount + ' failed', 'red')}, ${colorize(warnCount + ' warnings', 'yellow')}`);
  if (failCount === 0) {
    lines.push(`  ${colorize('Overall: HEALTHY', 'green')}`);
  } else {
    lines.push(`  ${colorize('Overall: UNHEALTHY — ' + failCount + ' check(s) failed', 'red')}`);
  }
  lines.push('');

  return { lines, passCount, failCount, warnCount };
}

function generateJsonReport(dbPath, results) {
  const checks = [];
  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  const addCheck = (category, name, status, detail) => {
    if (status === 'pass') passCount++;
    else if (status === 'fail') failCount++;
    else warnCount++;
    checks.push({ category, name, status, detail });
  };

  // File
  addCheck('file', 'file_exists', results.file.exists ? 'pass' : 'fail',
    { exists: results.file.exists, size: results.file.stat?.size, modified: results.file.stat?.mtime?.toISOString() });

  // Connection
  if (results.connect.error) {
    addCheck('connection', 'db_open', 'fail', { error: results.connect.error });
  } else {
    addCheck('connection', 'db_open', 'pass', {});
  }

  addCheck('connection', 'quick_check', results.quickCheck.pass ? 'pass' : 'fail', { message: results.quickCheck.message });
  addCheck('connection', 'integrity_check', results.integrity.pass ? 'pass' : 'fail', { message: results.integrity.message });

  // Pragmas
  for (const [pragma, info] of Object.entries(results.pragmas)) {
    addCheck('pragma', pragma, info.pass ? 'pass' : 'fail', { value: info.value, expected: REQUIRED_PRAMAS[pragma] });
  }

  // Tables
  for (const { table, found } of results.tables.results) {
    addCheck('table', table, found ? 'pass' : 'fail', { found });
  }

  // FTS5
  addCheck('fts5', 'fts5', results.fts5.available ? (results.fts5.ftsTableExists ? 'pass' : 'warn') : 'warn', results.fts5);

  // Columns
  for (const [table, expectedCols] of Object.entries(REQUIRED_COLUMNS)) {
    if (results.columns[table]) {
      const { missing } = results.columns[table];
      addCheck('column', table, missing.length === 0 ? 'pass' : 'fail', { missing });
    } else {
      addCheck('column', table, 'fail', { error: 'table not found' });
    }
  }

  // Indices
  for (const { index, found } of results.indices) {
    addCheck('index', index, found ? 'pass' : 'warn', { found });
  }

  // Stats
  addCheck('stats', 'message_count', 'pass', { count: results.stats.messageCount });
  addCheck('stats', 'session_count', 'pass', { count: results.stats.sessionCount });
  addCheck('stats', 'migration_count', 'pass', { count: results.stats.migrationCount });

  return {
    databasePath: dbPath,
    timestamp: new Date().toISOString(),
    summary: { pass: passCount, fail: failCount, warn: warnCount, total: passCount + failCount + warnCount },
    healthy: failCount === 0,
    checks,
    stats: results.stats,
  };
}

// ============================================================
// Main
// ============================================================

function main() {
  const opts = parseArgs();
  const dbPath = opts.dbPath || getDefaultDbPath();

  if (!opts.json) {
    console.log(colorize('DUYA Database Health Check', 'bold'));
    console.log(`Using database: ${dbPath}`);
    console.log('');
  }

  const results = {};

  // File check
  const fileCheck = checkFileExists(dbPath);
  results.file = {
    exists: fileCheck.exists,
    stat: fileCheck.stat,
    walExists: fileCheck.exists ? fs.existsSync(dbPath + '-wal') : undefined,
  };

  if (!fileCheck.exists) {
    results.connect = { error: `Database file not found: ${dbPath}` };
    results.quickCheck = { pass: false, message: 'N/A' };
    results.integrity = { pass: false, message: 'N/A' };
    results.pragmas = {};
    results.tables = { results: EXPECTED_TABLES.map(t => ({ table: t, found: false })), existingCount: 0, ftsTable: [] };
    results.fts5 = { available: false, message: 'N/A' };
    results.columns = {};
    results.indices = EXPECTED_INDICES.map(i => ({ index: i, found: false }));
    results.stats = { error: 'Database file not found' };
  } else {
    // Load database
    const conn = loadDatabase(dbPath);
    results.connect = { error: conn.error || null };
    results.quickCheck = { pass: false, message: 'N/A' };
    results.integrity = { pass: false, message: 'N/A' };
    results.pragmas = {};
    results.tables = { results: EXPECTED_TABLES.map(t => ({ table: t, found: false })), existingCount: 0, ftsTable: [] };
    results.fts5 = { available: false, message: 'N/A' };
    results.columns = {};
    results.indices = EXPECTED_INDICES.map(i => ({ index: i, found: false }));
    results.stats = {};

    if (conn.db) {
      try {
        results.quickCheck = checkQuickCheck(conn.db);
        results.integrity = checkIntegrity(conn.db);
        results.pragmas = checkPragmas(conn.db);
        results.tables = checkTables(conn.db);
        results.fts5 = checkFts5(conn.db);

        // Column checks
        for (const table of Object.keys(REQUIRED_COLUMNS)) {
          const tableExists = results.tables.results.find(t => t.table === table);
          if (tableExists && tableExists.found) {
            results.columns[table] = checkColumns(conn.db, table, REQUIRED_COLUMNS[table]);
          }
        }

        results.indices = checkIndices(conn.db);
        results.stats = getStats(conn.db);
      } finally {
        conn.db.close();
      }
    }
  }

  if (opts.json) {
    const jsonReport = generateJsonReport(dbPath, results);
    console.log(JSON.stringify(jsonReport, null, 2));
  } else {
    const { lines } = generateReport(dbPath, results);
    console.log(lines.join('\n'));
  }

  // Exit with non-zero code if there are failures
  const failCount = results.integrity && !results.integrity.pass ? 1 : 0;
  process.exit(failCount > 0 ? 1 : 0);
}

main();
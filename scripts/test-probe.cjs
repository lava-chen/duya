const { app } = require('electron');
const path = require('node:path');
const { writeFileSync, mkdirSync } = require('node:fs');
const { execPath } = process;
const ud = path.join(require('os').tmpdir(), 'duya-probe-' + Date.now());
mkdirSync(ud, {recursive: true});
app.setName('DUYA');
app.setPath('userData', ud);
app.on('browser-window-created', (_e, w) => { try { w.destroy(); } catch {} });
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const { startCliApiServer, getSessionSummary, listSessionSummaries } = require('../packages/agent/bundle/cli-api-server.cjs');
    const handle = await startCliApiServer();
    mkdirSync(path.join(ud, 'runtime'), {recursive: true});
    writeFileSync(path.join(ud, 'runtime/cli-api.json'), JSON.stringify({port: handle.port, token: handle.token, pid: process.pid, startedAt: handle.startedAt}, null, 2));
    const Database = require('better-sqlite3');
    const db = new Database(path.join(ud, 'databases/duya-main.db'));
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', working_directory TEXT NOT NULL DEFAULT '', project_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', mode TEXT NOT NULL DEFAULT 'code', permission_profile TEXT NOT NULL DEFAULT 'default', provider_id TEXT NOT NULL DEFAULT 'env', context_summary TEXT NOT NULL DEFAULT '', context_summary_updated_at INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, agent_profile_id TEXT DEFAULT NULL, parent_id TEXT REFERENCES chat_sessions(id), agent_type TEXT NOT NULL DEFAULT 'main', agent_name TEXT NOT NULL DEFAULT '')`);
    db.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, msg_type TEXT NOT NULL DEFAULT 'text', status TEXT NOT NULL DEFAULT 'done', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE)`);
    db.prepare(`INSERT INTO chat_sessions (id, title, created_at, updated_at, model, mode, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('s1','t1', Date.now(), Date.now(), '', 'code', 0);
    db.close();
    const r1 = getSessionSummary('s1');
    process.stderr.write(`getSessionSummary('s1') = ${JSON.stringify(r1)}\n`);
    const list = listSessionSummaries({});
    process.stderr.write(`listSessionSummaries() = ${JSON.stringify(list)}\n`);
  } catch (err) {
    process.stderr.write('error: ' + err.stack + '\n');
  }
  app.exit(0);
});

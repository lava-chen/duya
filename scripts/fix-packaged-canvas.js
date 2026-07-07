/**
 * fix-packaged-canvas.js — One-shot repair for packaged DUYA installs
 * missing `conductor_canvases.project_path` (and the unique index that
 * pairs with it).
 *
 * Plan #39 Phase 4.3.6.  Background: see
 * `docs/exec-plans/active/39-beta-launch-preparation.md` Phase 4.
 *
 * The fix is normally applied on startup by `ensureConductorCanvasColumns`
 * in `electron/db/schema.ts` (added in the same plan). This script exists
 * so a user can recover WITHOUT re-installing the packaged build, and so
 * CI can verify the user's DB before / after the next release.
 *
 * Usage:
 *   node scripts/fix-packaged-canvas.js                 # auto-detect DB path
 *   node scripts/fix-packaged-canvas.js --db <path>     # explicit path
 *   node scripts/fix-packaged-canvas.js --dry-run       # show what would change
 *   node scripts/fix-packaged-canvas.js --sql-only      # print SQL to stdout (for piping into sqlite3)
 *
 * Exit codes:
 *   0 = column was already present OR was successfully added
 *   1 = DB file not found
 *   2 = better-sqlite3 binary is ABI-incompatible with this Node (try `--sql-only`)
 *   3 = repair failed (see stderr)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

function getDefaultDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'DUYA', 'databases', 'duya-main.db');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DUYA', 'databases', 'duya-main.db');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'DUYA', 'databases', 'duya-main.db');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dbPath: null, dryRun: false, sqlOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      opts.dbPath = args[++i];
    } else if (args[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (args[i] === '--sql-only') {
      opts.sqlOnly = true;
    }
  }
  return opts;
}

const SQL_STATEMENTS = [
  { ddl: 'ALTER TABLE conductor_canvases ADD COLUMN project_path TEXT', guard: "ALTER TABLE conductor_canvases ADD COLUMN project_path" },
  { ddl: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_conductor_canvases_project_path ON conductor_canvases(project_path) WHERE project_path IS NOT NULL' },
];

function loadDatabase(dbPath) {
  try {
    const Database = require('better-sqlite3');
    return { db: new Database(dbPath) };
  } catch (err) {
    return { error: err };
  }
}

function describeColumn(db, columnName) {
  const cols = db.prepare('PRAGMA table_info(conductor_canvases)').all();
  return cols.find((c) => c.name === columnName) || null;
}

function indexExists(db, indexName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName);
  return !!row;
}

function repair(db, dryRun) {
  const before = describeColumn(db, 'project_path');
  const indexAlreadyPresent = indexExists(db, 'idx_conductor_canvases_project_path');
  if (before && indexAlreadyPresent) {
    return { changed: false, reason: 'already up-to-date' };
  }

  const actions = [];
  if (!before) {
    actions.push('ADD COLUMN conductor_canvases.project_path');
    if (!dryRun) {
      try {
        db.exec(SQL_STATEMENTS[0].ddl);
      } catch (err) {
        return { changed: false, error: `ALTER TABLE failed: ${err.message}` };
      }
    }
  }
  if (!indexAlreadyPresent) {
    actions.push('CREATE UNIQUE INDEX idx_conductor_canvases_project_path');
    if (!dryRun) {
      try {
        db.exec(SQL_STATEMENTS[1].ddl);
      } catch (err) {
        return { changed: false, error: `CREATE INDEX failed: ${err.message}` };
      }
    }
  }

  return { changed: true, actions };
}

function main() {
  const opts = parseArgs();
  const dbPath = opts.dbPath || getDefaultDbPath();

  if (opts.sqlOnly) {
    process.stdout.write(SQL_STATEMENTS.map((s) => s.ddl).join(';\n') + ';\n');
    process.exit(0);
  }

  process.stdout.write(`[fix-packaged-canvas] target DB: ${dbPath}\n`);
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`[fix-packaged-canvas] ERROR: database file not found.\n`);
    process.stderr.write(`Pass --db <path> to override, or use --sql-only and pipe the SQL into sqlite3.\n`);
    process.exit(1);
  }

  const { db, error } = loadDatabase(dbPath);
  if (error) {
    process.stderr.write(`[fix-packaged-canvas] ERROR: failed to open database: ${error.message}\n`);
    if (/NODE_MODULE_VERSION/.test(String(error.message))) {
      process.stderr.write(
        `\nThis usually means the bundled better-sqlite3 binary was compiled for Electron's Node ABI,\n` +
        `and this script is being run with a different Node (e.g. dev Node 22+).\n` +
        `Workarounds:\n` +
        `  1. Re-run via the packaged DUYA binary's bundled Node (electron-embedded).\n` +
        `  2. Use --sql-only and pipe the output into sqlite3.exe:\n` +
        `       node scripts/fix-packaged-canvas.js --sql-only | sqlite3.exe "${dbPath}"\n`,
      );
    }
    process.exit(2);
  }

  let result;
  try {
    result = repair(db, opts.dryRun);
  } finally {
    db.close();
  }

  if (result.error) {
    process.stderr.write(`[fix-packaged-canvas] ERROR: ${result.error}\n`);
    process.exit(3);
  }

  if (!result.changed) {
    process.stdout.write(`[fix-packaged-canvas] OK — ${result.reason}. No migration needed.\n`);
    process.exit(0);
  }

  if (opts.dryRun) {
    process.stdout.write(`[fix-packaged-canvas] DRY-RUN — would apply:\n`);
    for (const a of result.actions) process.stdout.write(`  - ${a}\n`);
    process.exit(0);
  }

  process.stdout.write(`[fix-packaged-canvas] OK — applied:\n`);
  for (const a of result.actions) process.stdout.write(`  - ${a}\n`);
  process.stdout.write(`\nNext step: launch DUYA once. The startup self-repair will be a no-op on subsequent runs.\n`);
  process.exit(0);
}

main();
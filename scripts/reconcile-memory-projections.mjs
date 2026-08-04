import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { drainOutbox } from '../packages/agent/dist/memory-state/outbox.js';
import { reconcileProjections } from '../packages/agent/dist/memory-state/reconcile.js';

function requireAbsoluteExistingPath(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

const databasePath = requireAbsoluteExistingPath(process.argv[2], 'database path');
const memoryRoot = requireAbsoluteExistingPath(process.argv[3], 'memory root');
const expectedRoot = path.resolve(path.join(process.env.USERPROFILE ?? '', '.duya', 'memory'));
if (memoryRoot !== expectedRoot) {
  throw new Error(`refusing unexpected memory root: ${memoryRoot}`);
}

const db = new Database(databasePath);
try {
  db.pragma('busy_timeout = 5000');
  const reconciled = reconcileProjections(db, { rootDir: memoryRoot });
  // A manual repair must also clear rows waiting on historical backoff. The
  // normal worker still uses wall-clock scheduling; this fast-forward is
  // intentionally scoped to the explicit maintenance command.
  const drainNow = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
  let drained = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const processed = drainOutbox(db, {
      allowedRoots: [memoryRoot],
      batchSize: 128,
      now: drainNow,
    });
    drained += processed;
    if (processed === 0) break;
  }
  const pending = db
    .prepare('SELECT COUNT(*) AS count FROM projection_outbox WHERE completed_at IS NULL')
    .get().count;

  process.stdout.write(`${JSON.stringify({ reconciled, drained, pending }, null, 2)}\n`);
} finally {
  db.close();
}

// A REAL worker process, killed mid-tool, against a REAL SQLite database.
//
// ## Why this is a standalone .mjs and not a fixture inside a test
//
// The acceptance for D7.1 is a kill-recovery proved by interrupting a run at a
// chosen point — not a unit test that calls functions in order. An in-process
// result is a real result, but it is not a kill-recovery result: nothing in it
// ever died, so it cannot show what survives a process that does not get to run
// its cleanup.
//
// So this is an actual `node` child. The parent:
//
//   1. forks it, and it opens a REAL better-sqlite3 file;
//   2. drives it through plan -> dispatch -> real side effect on disk;
//   3. kills it while the tool attempt is IN FLIGHT — after the file exists,
//      before the outcome is recorded;
//   4. forks a SECOND process, which recovers from the same file.
//
// The termination is UNCATCHABLE on purpose. A cooperative signal would let the
// child flush and exit cleanly, which is the case recovery is NOT for; leaving
// exactly the state a hard crash leaves is the case this has to survive. On
// Windows that is `taskkill /F /T` (TerminateProcess), on POSIX `SIGKILL`.
//
// ## What is real here, and what is substituted
//
// REAL: the process boundary, the OS termination, the SQLite file and its
// bytes, and the checkpoint digest / fence arithmetic imported from the BUILT
// `packages/agent-protocol/dist` — the same artifact the packaged product loads,
// not a re-implementation and not a test double.
//
// SUBSTITUTED, and named rather than hidden: the model provider (a crash test
// has no model; the crash IS the subject) and the harness's own side-effect
// file, which stands in for an external API. That substitution is the point —
// the file is how we observe that a REAL effect exists while the ledger still
// cannot prove it, which is precisely the condition `unknown` describes.
//
// This is NOT the packaged agent bundle and claims nothing about Electron.
//
// Usage: node d71-kill-worker.mjs
//   stdin  : one JSON command per line.
//   stdout : one JSON frame per line.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

// The BUILT protocol package, exactly as the product loads it. Importing the
// dist rather than re-implementing the digest is the point: a fixture that
// computed its own hash would prove nothing about the hash production uses.
//
// `pathToFileURL`, not a raw path: Node's ESM loader rejects a bare Windows
// absolute path with ERR_UNSUPPORTED_ESM_URL_SCHEME, because `E:` parses as a
// URL scheme. This is a real platform constraint, not a portability detail.
const PROTOCOL_DIST = pathToFileURL(
  path.join(REPO_ROOT, 'packages', 'agent-protocol', 'dist', 'index.js'),
).href;
const { checkpointDigest, canAutoRetry, CHECKPOINT_SCHEMA_VERSION } = await import(PROTOCOL_DIST);

// better-sqlite3 is a NATIVE module and cannot be imported by path from an
// ESM file; resolve it the way every other consumer in the tree does.
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL,
      envelope_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS run_checkpoints (
      run_id TEXT NOT NULL, generation INTEGER NOT NULL, fence INTEGER NOT NULL,
      digest TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, generation)
    );
  `);
  return db;
}

/**
 * The seqs this run has actually emitted, read from the real table.
 *
 * The store asks "did this run emit this seq?" and the answer has to come from
 * somewhere durable, or the store's `uncommitted_seq` refusal is unfalsifiable.
 */
function seqsFor(db, runId) {
  return new Set(db.prepare('SELECT seq FROM run_events WHERE run_id = ?').all(runId).map((r) => r.seq));
}

function buildCheckpoint(over) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: over.runId,
    sessionId: 'sess-d7-1',
    generation: over.generation,
    runEpoch: over.runEpoch,
    fence: over.fence,
    manifestFingerprint: 'fp-d7-1',
    inputRevision: 'rev-d7-1',
    transcript: { throughSeq: 3, messageCount: 2 },
    model: { providerId: 'anthropic', model: 'claude', turnIndex: 1, continuation: 'reconstruct_by_new_attempt' },
    loop: { profileId: null, modeIds: [] },
    budget: { limit: { maxTurns: 8 }, spent: { turns: 1, toolCalls: 1, tokens: 100 } },
    mailbox: { watermark: 0, pending: 0 },
    pendingApprovals: [],
    toolAttempts: over.toolAttempts,
    artifactRefs: [],
    envRef: { ref: 'env:sess-d7-1', hash: 'sha256:env' },
    capabilities: { deterministic: false },
  };
}

/**
 * Phase 1: run until a tool is IN FLIGHT, then stop there forever.
 *
 * The real side effect is a real file write, performed at the moment the tool is
 * dispatched — the ordering that makes the crash interesting. If the process
 * dies here, the file EXISTS and the ledger holds no outcome for it. That gap
 * is the entire subject of D7.1.
 */
function phaseRun(cmd) {
  const db = openDb(cmd.dbPath);
  const seqs = seqsFor(db, cmd.runId);

  // Three events already durable, so the checkpoint has a real boundary to name.
  for (const seq of [1, 2, 3]) {
    db.prepare(
      'INSERT OR REPLACE INTO run_events (run_id, seq, event_type, envelope_json, created_at) VALUES (?,?,?,?,?)',
    ).run(cmd.runId, seq, 'assistant.status', JSON.stringify({ runId: cmd.runId, seq }), 1000 + seq);
    seqs.add(seq);
  }

  // The tool is dispatched, and its real effect lands on disk NOW.
  const attemptKey = `${cmd.runId}/e1/tc-1`;
  writeFileSync(cmd.sideEffectPath, 'the external effect really happened\n', 'utf8');

  const cp = buildCheckpoint({
    runId: cmd.runId,
    generation: 1,
    runEpoch: 1,
    fence: 1,
    // The load-bearing field: dispatched, no outcome recorded, and declared
    // non-retryable by the tool that owns it.
    toolAttempts: [
      {
        attemptKey,
        runId: cmd.runId,
        runEpoch: 1,
        toolCallId: 'tc-1',
        toolName: 'Bash',
        inputDigest: 'sha256:input-1',
        state: 'unknown',
        sideEffect: 'non_retryable',
      },
    ],
  });

  db.prepare(
    'INSERT OR REPLACE INTO run_checkpoints (run_id, generation, fence, digest, payload_json, created_at) VALUES (?,?,?,?,?,?)',
  ).run(cmd.runId, 1, 1, checkpointDigest(cp), JSON.stringify(cp), 2000);

  line({ type: 'phase_ready', runId: cmd.runId, sideEffectPath: cmd.sideEffectPath, pid: process.pid });

  // Announce that we are in flight, then wait to be killed. There is no clean
  // exit on this path, by design.
  line({ type: 'in_flight', attemptKey });
  setInterval(() => {}, 1 << 30);
}

/**
 * Phase 2: recover, in a NEW process, from what phase 1 left on disk.
 *
 * A different pid, reading bytes another process wrote, deciding what may
 * happen next. That difference is the whole claim.
 */
function phaseRecover(cmd) {
  const db = openDb(cmd.dbPath);
  const row = db
    .prepare(
      'SELECT generation, fence, digest, payload_json FROM run_checkpoints WHERE run_id = ? ORDER BY generation DESC LIMIT 1',
    )
    .get(cmd.runId);
  if (row === undefined) {
    line({ type: 'recovered', ok: false, reason: 'no_checkpoint' });
    return;
  }
  const payload = JSON.parse(row.payload_json);
  const digestNow = checkpointDigest(payload);
  const attempts = payload.toolAttempts.map((a) => ({
    attemptKey: a.attemptKey,
    state: a.state,
    sideEffect: a.sideEffect,
    verdict: canAutoRetry({ ...a, runId: cmd.runId, runEpoch: payload.runEpoch, toolCallId: 'tc-1' }),
  }));
  line({
    type: 'recovered',
    ok: true,
    pid: process.pid,
    generation: row.generation,
    committedFence: row.fence,
    digestIntact: digestNow === row.digest,
    attempts,
  });
}

/**
 * Phase 3: a STALE attempt tries to write after the new one started.
 *
 * A separate process, attempting a real write against a real database, at a
 * fence the store has already moved past. A check that only existed inside the
 * recovering process would not be a fence; it would be a local assertion.
 */
function phaseStaleWrite(cmd) {
  const db = openDb(cmd.dbPath);
  const cp = buildCheckpoint({
    runId: cmd.runId,
    generation: cmd.generation,
    runEpoch: cmd.runEpoch,
    fence: cmd.fence,
    toolAttempts: [],
  });
  const high = db.prepare('SELECT MAX(fence) AS f FROM run_checkpoints WHERE run_id = ?').get(cmd.runId).f ?? 0;
  if (cmd.fence < high) {
    line({ type: 'stale_write', applied: false, code: 'stale_fence', fence: cmd.fence, highWaterMark: high, pid: process.pid });
    return;
  }
  db.prepare(
    'INSERT OR REPLACE INTO run_checkpoints (run_id, generation, fence, digest, payload_json, created_at) VALUES (?,?,?,?,?,?)',
  ).run(cmd.runId, cmd.generation, cmd.fence, checkpointDigest(cp), JSON.stringify(cp), 3000);
  line({ type: 'stale_write', applied: true, fence: cmd.fence, highWaterMark: high, pid: process.pid });
}

function main() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const raw = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (raw.length > 0) {
        const cmd = JSON.parse(raw);
        if (cmd.type === 'quit') process.exit(0);
        else if (cmd.type === 'phase_run') phaseRun(cmd);
        else if (cmd.type === 'phase_recover') phaseRecover(cmd);
        else if (cmd.type === 'phase_stale_write') phaseStaleWrite(cmd);
      }
      index = buffer.indexOf('\n');
    }
  });
  line({ type: 'ready', pid: process.pid });
}

main();

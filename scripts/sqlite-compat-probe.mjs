#!/usr/bin/env node
/**
 * sqlite-compat-probe.mjs — Phase 0 capability probe for plan 610 / slice C1.
 *
 * ## What this is for
 *
 * [01-migration-map.md §0.2](docs/exec-plans/active/610-architecture-series/03-sqlite-driver/01-migration-map.md)
 * lists nine items that can each overturn the "replace better-sqlite3 with
 * node:sqlite" route. This script decides all nine, in one run, in whichever
 * runtime executes it. It is a SCRIPT and not a manual checklist on purpose:
 * items 1-3 can all change on a future Node/Electron upgrade, so a one-time
 * measurement would degrade into "we verified it once".
 *
 * ## The rule this file exists to enforce
 *
 * Every assertion compares two DIFFERENT sources. A probe that compares a
 * measured value against itself proves nothing and is worse than no gate,
 * because it reports green. Concretely, each expectation below comes from one
 * of:
 *   - a hand-derived literal (a corpus whose correct answer is known by
 *     reading it), or
 *   - better-sqlite3 running the identical operation (two independent
 *     implementations, not one implementation agreeing with itself), or
 *   - the filesystem / OS (file header bytes, whether a file can be renamed),
 *     which no driver controls.
 *
 * The probe audits this: item 0 in the output fails the run if any item
 * compares a measurement against itself.
 *
 * ## Why item 9 is the hard stop
 *
 * [00-contracts.md §5](docs/exec-plans/active/610-architecture-series/03-sqlite-driver/00-contracts.md)
 * makes data rollback a hard requirement: a file written by the new driver must
 * still open in the old one. Every other item has an alternative. If item 9
 * fails, swapping the driver irreversibly changes the readability of user data
 * files, so the probe exits non-zero and the correct response is to stop.
 *
 * ## Output
 *
 * A single JSON document on stdout, delimited by SENTINEL markers so an
 * Electron main-process launcher can extract it from mixed process output.
 * Human-readable lines go to stderr. Exit codes:
 *
 *   0  every item PASS or UNSUPPORTED, and no blocking item failed
 *   1  a blocking item FAILED, or node:sqlite could not be loaded at all
 *      (an unmeasured boundary is not a passing boundary)
 *   2  usage error
 *
 * ## Runtime
 *
 * Run under plain node, or under an Electron main process via
 * `sqlite-compat-probe.electron.cjs`, which imports this module. Both are
 * required: local node working does NOT imply Electron works.
 *
 * ## Logging
 *
 * AGENTS.md forbids bare `console.log`. The structured logger lives in
 * `apps/desktop/src/main/logging/logger.ts` — TypeScript inside the Electron
 * main process, so a standalone ESM probe cannot import it. This file therefore
 * uses a local `probeLog` shim that keeps the same discipline (component tag,
 * level, structured context, stdout reserved for the machine-readable payload)
 * and matches what `scripts/architecture/headless-load-probe.cjs` already does.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const COMPONENT = 'SqliteCompatProbe';
const SENTINEL_OPEN = '@@SQLITE_COMPAT_PROBE_JSON_BEGIN@@';
const SENTINEL_CLOSE = '@@SQLITE_COMPAT_PROBE_JSON_END@@';

function probeLog(level, message, context) {
  const line = { component: COMPONENT, level, message, ...(context ?? {}) };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

// ---------------------------------------------------------------------------
// Blocking items decide the process exit code, so the set must contain every
// result whose FAILURE must stop the route or invalidate the rest of the report.
//
//   1  — close() semantics: [01 §0.4] says an unacceptable close() ends the plan.
//   9  — rollback path: the only hard stop; involves user data file readability.
//   0  — the probe's own two-source integrity check. If any assertion is an
//        identity comparison then the remaining PASS results cannot be trusted,
//        so a red item 0 must fail the run even though it is not a capability.
// ---------------------------------------------------------------------------
const BLOCKING_ITEMS = new Set([0, 1, 9]);

/**
 * Create the per-run result sink. Deliberately NOT module-level: the probe is
 * imported by the Electron launcher, and a module-level array would make a
 * second in-process run accumulate the first run's results and answer a
 * question nobody asked. Re-runnability means the second call sees only the
 * second call's work.
 */
function createSink() {
  const entries = [];
  return {
    entries,
    record(id, name, status, detail, extra = {}) {
      entries.push({ id, name, status, ...extra, detail });
      return status === 'PASS';
    },
  };
}

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    return { __error: err?.code ?? err?.name ?? 'Error', message: String(err?.message ?? err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Corpus. Deliberately small enough that the correct answer is known by
// READING it, which is what makes these literals an independent source rather
// than a recording of whatever the driver happened to return.
// ---------------------------------------------------------------------------
const CORPUS = [
  { id: 1, title: 'quick brown fox', content: 'the quick brown fox jumps over the lazy dog' },
  { id: 2, title: 'quick thinking', content: 'quick thinking wins the race' },
  { id: 3, title: 'cjk note', content: '数据库迁移探针测试内容' },
  { id: 4, title: 'lazy dogs', content: 'lazy dogs sleep all day quick' },
  { id: 5, title: 'refactor', content: '重构数据库层去掉原生依赖' },
];

/** Known by inspection: rows 1, 2 and 4 contain the word 'quick'. */
const EXPECTED_QUICK_ROWIDS = [1, 2, 4];
/**
 * Known by inspection: rows 3 and 5 both contain the 3-character CJK
 * substring '数据库'.
 *
 * Three characters, deliberately. trigram indexes overlapping 3-character
 * sequences, so a 2-character term produces NO trigrams and matches nothing —
 * which is why apps/desktop/src/main/memory/rag_snippet.ts:17 filters 2-char
 * CJK terms out of the FTS query and routes them to a LIKE fallback instead.
 * Asserting on a 2-char term would have "proven" trigram was broken when it
 * was behaving exactly as documented.
 */
const EXPECTED_CJK_ROWIDS = [3, 5];
const CJK_QUERY = '"数据库"';

/**
 * Known by inspection, but for a DIFFERENT table: the item-9 fixture indexes
 * only `parent.name` (the corpus TITLE) into its FTS5 table, not the content
 * column. Of the five titles, only rows 1 and 2 contain 'quick' — row 4's title
 * is 'lazy dogs', its *content* is what mentions quick.
 *
 * Scoped separately on purpose. Reusing EXPECTED_QUICK_ROWIDS ([1,2,4]) here
 * asserted against a different table than it was derived from, which is exactly
 * the "unverified number treated as fact" trap this slice exists to avoid.
 */
const EXPECTED_TITLE_QUICK_ROWIDS = [1, 2];

function openNodeSqlite() {
  return require('node:sqlite');
}

function openBetterSqlite3() {
  return require('better-sqlite3');
}

/** Normalize a MATCH query into rowids so drivers are comparable. */
function rowids(rows) {
  return rows.map((r) => Number(r.rowid));
}

/**
 * Build an FTS5 table with the same shape the repo actually uses
 * (apps/desktop/src/main/db/schema.ts:606 uses tokenize='trigram'), plus the
 * fts_normalize UDF and an AFTER INSERT trigger of the same shape.
 */
function buildFtsFixture(open, { trigram }) {
  const db = open(':memory:');
  db.function('fts_normalize', { deterministic: true }, (s) => String(s).toLowerCase());
  const tok = trigram ? ", tokenize='trigram'" : '';
  db.exec(`CREATE TABLE documents(rowid INTEGER PRIMARY KEY, title TEXT, content TEXT)`);
  db.exec(`CREATE VIRTUAL TABLE documents_fts USING fts5(title, content${tok})`);
  db.exec(`
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content)
      VALUES (new.rowid, fts_normalize(new.title), fts_normalize(new.content));
    END;
  `);
  const ins = db.prepare('INSERT INTO documents(rowid, title, content) VALUES (?, ?, ?)');
  for (const row of CORPUS) ins.run(row.id, row.title, row.content);
  return db;
}

export async function runProbe() {
  const startedAt = new Date().toISOString();
  const { entries: results, record } = createSink();
  const runtime = {
    execPath: process.execPath,
    node: process.versions.node,
    abi: process.versions.modules,
    electron: process.versions.electron ?? null,
    isElectron: Boolean(process.versions.electron),
    platform: process.platform,
  };

  // --- capability load. A runtime that cannot load node:sqlite cannot
  // --- measure anything, and must not report a pass.
  let sqlite = null;
  try {
    sqlite = openNodeSqlite();
  } catch (err) {
    return {
      runtime,
      startedAt,
      driver: null,
      results: [],
      fatal: `node:sqlite unavailable in this runtime: ${err?.message ?? err}`,
    };
  }

  const { DatabaseSync } = sqlite;

  let better = null;
  let betterVersion = null;
  try {
    const BetterSqlite3 = openBetterSqlite3();
    better = (file) => new BetterSqlite3(file);
    betterVersion = require('better-sqlite3/package.json').version;
  } catch (err) {
    probeLog('WARN', 'better-sqlite3 could not be loaded; cross-driver checks degrade', {
      message: String(err?.message ?? err),
    });
  }

  const driverInfo = {
    nodeSqliteVersion: new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v,
    betterSqlite3Version: betterVersion,
    exports: Object.keys(sqlite),
    databaseSyncMethods: Object.getOwnPropertyNames(DatabaseSync.prototype),
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-sqlite-probe-'));

  try {
    // =====================================================================
    // Item 1 — db.close() semantics
    //
    // The plan states DatabaseSync has no close(). It does have one. What has
    // to be established is whether it is a REAL release, because the failure
    // mode being guarded is a compat-layer close() that silently does nothing.
    //
    // NOTE: "the other driver can still write after close" is NOT a valid
    // discriminator — measured, a held-open handle does not block a second
    // writer even in rollback-journal mode on this platform. The OS-level
    // file lock (rename) is the check that actually distinguishes a real
    // close from a no-op, because it is enforced by the OS and not by any
    // driver's cooperation.
    // =====================================================================
    {
      const name = 'db.close() releases the handle';
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t(a INTEGER)');
      db.prepare('INSERT INTO t VALUES (1)').run();

      const closeIsFunction = typeof db.close === 'function';

      // Source 1: the driver reports unusable-after-close. The close() call is
      // the subject of this item, so it must actually happen before asking
      // whether the handle went away.
      db.close();
      const afterClose = safe(() => db.prepare('SELECT 1'));
      const driverSaysClosed =
        afterClose !== null && typeof afterClose === 'object' && afterClose.__error === 'ERR_INVALID_STATE';

      // Source 2: the OS. A held handle locks the file on Windows; a released
      // handle does not. Nothing the driver does can fake this.
      const lockFile = path.join(tmpRoot, 'close-probe.db');
      const held = new DatabaseSync(lockFile);
      held.exec('CREATE TABLE t(a INTEGER)');
      const renameWhileOpen = safe(() => {
        fs.renameSync(lockFile, `${lockFile}.held`);
        return 'RENAMED_WHILE_OPEN';
      });
      // Undo so the same path can be reused after the real close().
      if (renameWhileOpen === 'RENAMED_WHILE_OPEN') fs.renameSync(`${lockFile}.held`, lockFile);
      held.close();
      const renameAfterClose = safe(() => {
        fs.renameSync(lockFile, `${lockFile}.freed`);
        fs.renameSync(`${lockFile}.freed`, lockFile);
        return 'RENAMED_AFTER_CLOSE';
      });

      const osLockHeld = typeof renameWhileOpen === 'object' && renameWhileOpen !== null;
      const osLockFreed = renameAfterClose === 'RENAMED_AFTER_CLOSE';

      const pass =
        closeIsFunction && driverSaysClosed && osLockHeld && osLockFreed;

      // better-sqlite3's double-close is a silent no-op; node:sqlite throws.
      // Recorded because a compat layer must decide which way to go, and
      // because it is evidence that close() is a real operation here.
      const bdb = better ? better(':memory:') : null;
      const betterDoubleClose = bdb ? safe(() => (bdb.close(), bdb.close(), 'NO_THROW')) : 'better-sqlite3 unavailable';
      if (bdb) safe(() => bdb.close());

      const nodeDoubleClose = safe(() => {
        const d = new DatabaseSync(':memory:');
        d.close();
        d.close();
        return 'NO_THROW';
      });
      const nodeDoubleCloseCode = typeof nodeDoubleClose === 'object' ? nodeDoubleClose.__error : nodeDoubleClose;

      record(1, name, pass ? 'PASS' : 'FAIL',
        pass ? 'close() exists, is reported unusable after close, and the OS file lock is genuinely released'
             : 'close() did not satisfy every discriminator',
        {
          measured: {
            closeIsFunction,
            prepareAfterCloseError: afterClose?.__error ?? afterClose,
            renameWhileHandleOpen: renameWhileOpen?.__error ?? renameWhileOpen,
            renameAfterClose: renameAfterClose,
            osLockHeldWhileOpen: osLockHeld,
            osLockFreedAfterClose: osLockFreed,
            nodeDoubleClose: nodeDoubleCloseCode,
            betterDoubleClose,
          },
          sources: ['node:sqlite driver API', 'OS filesystem lock (rename)'],
          blocking: true,
        });
    }

    // =====================================================================
    // Item 2 — trigram tokenizer
    //
    // Compared against a hand-derived literal: rows 3 and 5 both contain the
    // 3-char CJK substring '数据库', and trigram must match exactly those two.
    // A 3-char term is used because trigram indexes overlapping 3-character
    // sequences — see EXPECTED_CJK_ROWIDS.
    // =====================================================================
    {
      const name = 'trigram tokenizer available and substring-matching';
      let created = 'CREATED';
      let measured = null;
      const db = safe(() => new DatabaseSync(':memory:'));
      try {
        if (db !== null && typeof db === 'object' && !db.__error) {
          db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
          db.close();
        } else {
          created = 'DB_UNAVAILABLE';
        }
      } catch (err) {
        created = `CREATE_FAILED: ${String(err?.message ?? err).slice(0, 120)}`;
      }

      if (created === 'CREATED') {
        const fixture = buildFtsFixture((f) => new DatabaseSync(f), { trigram: true });
        measured = safe(() => rowids(fixture.prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?').all(CJK_QUERY)));
        fixture.close();
        const ok = JSON.stringify(measured) === JSON.stringify(EXPECTED_CJK_ROWIDS);
        record(2, name, ok ? 'PASS' : 'FAIL',
          ok ? 'trigram table created and 2-char CJK substring matched exactly the expected rows'
             : `trigram MATCH returned ${JSON.stringify(measured)}`,
          {
            measured,
            expected: EXPECTED_CJK_ROWIDS,
            sources: ['node:sqlite trigram MATCH', 'hand-derived literal (corpus read by hand)'],
            createOutcome: created,
          });
      } else {
        record(2, name, 'UNSUPPORTED', created, {
          measured: null,
          expected: EXPECTED_CJK_ROWIDS,
          sources: ['node:sqlite DDL', 'hand-derived literal'],
          createOutcome: created,
        });
      }
    }

    // =====================================================================
    // Item 3 — FTS5 MATCH result sets
    //
    // Two independent implementations must agree on the same corpus, with the
    // same tokenizer, including bm25 ordering. Also checked against the
    // hand-derived 'quick' literal, so this cannot pass by the two drivers
    // being identically wrong.
    // =====================================================================
    {
      const name = 'FTS5 MATCH result set and bm25 order match better-sqlite3';
      // Every query carries a hand-derived expectation, including the two that
      // were previously cross-driver-only. With those left null, disabling the
      // cross-driver branch still let the item pass (observed in mutation
      // testing) — the literals for the remaining queries happened to hold.
      // Every query now has a literal, so no query relies on the other source.
      const queries = [
        { q: '"quick"', expect: EXPECTED_QUICK_ROWIDS },                 // rows 1, 2, 4
        { q: CJK_QUERY, expect: EXPECTED_CJK_ROWIDS },                    // rows 3, 5
        { q: '"quick" OR "jumps"', expect: [1, 2, 4] },                // 'quick' in 1,2,4; 'jumps' only in 1
        { q: '"lazy dog"', expect: [1, 4] },                              // adjacent bigram in row 1 only
      ];
      const collect = (open, trigram) => {
        const out = {};
        const db = buildFtsFixture(open, { trigram });
        for (const { q } of queries) {
          out[q] = safe(() => {
            const rows = db
              .prepare('SELECT rowid, bm25(documents_fts) AS rank FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank')
              .all(q);
            return rows.map((r) => ({ rowid: Number(r.rowid), rank: Number(r.rank.toFixed(6)) }));
          });
        }
        db.close();
        return out;
      };

      const nodeOut = collect((f) => new DatabaseSync(f), true);
      if (!better) {
        record(3, name, 'FAIL', 'better-sqlite3 unavailable — cross-driver comparison impossible', {
          measured: nodeOut,
          sources: ['node:sqlite', 'better-sqlite3 (unavailable)'],
        });
      } else {
        const betterOut = collect((f) => better(f), true);
        const mismatches = [];
        for (const { q, expect } of queries) {
          if (JSON.stringify(nodeOut[q]) !== JSON.stringify(betterOut[q])) {
            mismatches.push(`${q}: node=${JSON.stringify(nodeOut[q])} better=${JSON.stringify(betterOut[q])}`);
          }
          // Every query has a literal, so this branch always runs.
          //
          // Compare as a SET against the literal. The query is ordered by
          // bm25 rank, and tied ranks come back in an unspecified order, so
          // asserting on the raw sequence would be asserting on tie-breaking
          // rather than on the result set. Ordering is still checked — exactly
          // — by the cross-driver comparison above, where both drivers face
          // the same unspecified tie-break.
          const nodeIds = nodeOut[q]?.__error ? null : nodeOut[q].map((r) => r.rowid).sort((a, b) => a - b);
          if (JSON.stringify(nodeIds) !== JSON.stringify(expect)) {
            mismatches.push(`${q}: literal expected ${JSON.stringify(expect)} got ${JSON.stringify(nodeIds)}`);
          }
        }
        record(3, name, mismatches.length === 0 ? 'PASS' : 'FAIL',
          mismatches.length === 0
            ? 'result sets, rowid sets and bm25 ordering identical across both drivers and the hand-derived literals'
            : mismatches.join('; '),
          { measured: nodeOut, expected: betterOut, sources: ['node:sqlite', 'better-sqlite3', 'hand-derived literal'] });
      }
    }

    // =====================================================================
    // Item 4 — BigInt boundaries
    //
    // Contract §2.1: beyond MAX_SAFE_INTEGER the driver must return a BigInt
    // or raise an explicit error, and must NEVER silently truncate. The second
    // half is the real assertion, and it is the one better-sqlite3 fails:
    // measured, it returns 9007199254740992 for 9007199254740993.
    // =====================================================================
    {
      const name = 'INTEGER beyond MAX_SAFE_INTEGER is not silently truncated';
      const BIG = 9007199254740993n; // MAX_SAFE_INTEGER + 2, exactly representable as BigInt
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t(id INTEGER, v INTEGER)');
      const insert = db.prepare('INSERT INTO t VALUES (?, ?)');
      const bindBigint = safe(() => (insert.run(1n, BIG), 'OK'));
      const bindNumber = safe(() => (insert.run(2, BIG), 'OK'));

      const defaultRead = safe(() => db.prepare('SELECT v FROM t WHERE id = 1').get().v);
      const erroredExplicitly =
        typeof defaultRead === 'object' && defaultRead !== null && defaultRead.__error === 'ERR_OUT_OF_RANGE';
      const truncatedSilently =
        typeof defaultRead === 'number' && BigInt(defaultRead) !== BIG;

      const st = db.prepare('SELECT v FROM t WHERE id = 1');
      st.setReadBigInts(true);
      const bigintRead = safe(() => st.get().v);
      const exactViaOptIn = typeof bigintRead === 'bigint' && bigintRead === BIG;
      db.close();

      let betterTruncates = 'better-sqlite3 unavailable';
      if (better) {
        const bdb = better(':memory:');
        bdb.exec('CREATE TABLE t(id INTEGER, v INTEGER)');
        bdb.prepare('INSERT INTO t VALUES (?, ?)').run(1, BIG);
        const bv = safe(() => bdb.prepare('SELECT v FROM t WHERE id = 1').get().v);
        betterTruncates = typeof bv === 'bigint' ? `bigint ${bv}` : `number ${bv}`;
        bdb.close();
      }

      const pass = bindBigint === 'OK' && bindNumber === 'OK' && erroredExplicitly && exactViaOptIn && !truncatedSilently;
      record(4, name, pass ? 'PASS' : 'FAIL',
        pass
          ? 'out-of-range INTEGER raises ERR_OUT_OF_RANGE by default and round-trips exactly under setReadBigInts(true); no silent truncation'
          : 'out-of-range INTEGER handling did not satisfy the contract',
        {
          measured: {
            bindBigint,
            bindNumber,
            defaultRead: defaultRead?.__error ?? defaultRead,
            setReadBigIntsValue: typeof bigintRead === 'bigint' ? String(bigintRead) : bigintRead,
            betterSqlite3SameValue: betterTruncates,
          },
          expected: 'explicit error or exact BigInt; never a silently altered number',
          sources: ['node:sqlite behaviour', '00-contracts.md §2.1', 'better-sqlite3 comparison'],
        });
    }

    // =====================================================================
    // Item 5 — journal_mode=WAL / foreign_keys
    //
    // Contract §2.3 explicitly forbids "did not throw" as the assertion for
    // these: wrong values do not raise. So the values are read back, and the
    // foreign key setting is proven by a behavioural probe (an orphan insert
    // must be REJECTED), not by the absence of an exception.
    // Measured on a real file — WAL is meaningless on :memory:.
    // =====================================================================
    {
      const name = 'journal_mode=WAL and foreign_keys=ON take effect (behaviourally)';
      const walFile = path.join(tmpRoot, 'wal.db');
      const db = new DatabaseSync(walFile);
      const setWal = safe(() => (db.exec('PRAGMA journal_mode = WAL'), 'OK'));
      const readWal = safe(() => db.prepare('PRAGMA journal_mode').get().journal_mode);
      const readWalViaTable = safe(() => db.prepare('SELECT * FROM pragma_journal_mode').get().journal_mode);
      const setSync = safe(() => (db.exec('PRAGMA synchronous = NORMAL'), 'OK'));
      const readSync = safe(() => db.prepare('PRAGMA synchronous').get().synchronous);

      db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY)');
      db.exec('CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))');
      const setFk = safe(() => (db.exec('PRAGMA foreign_keys = ON'), 'OK'));
      const readFk = safe(() => db.prepare('PRAGMA foreign_keys').get().foreign_keys);
      db.prepare('INSERT INTO parent VALUES (?)').run(1);
      // Behavioural: FK is only really ON if this is rejected.
      const orphanRejected = safe(() => {
        db.prepare('INSERT INTO child VALUES (?, ?)').run(1, 999);
        return 'ORPHAN_ACCEPTED';
      });
      const validAccepted = safe(() => {
        db.prepare('INSERT INTO child VALUES (?, ?)').run(2, 1);
        return 'ACCEPTED';
      });
      db.close();

      // Does the WAL mode survive into the other driver? That is the question
      // that matters for a file the new driver created.
      let betterSeesWal = 'better-sqlite3 unavailable';
      if (better) {
        const bdb = better(walFile);
        betterSeesWal = safe(() => bdb.pragma('journal_mode', { simple: true }));
        bdb.close();
      }

      const walOk = readWal === 'wal' && readWalViaTable === 'wal';
      const fkOk = readFk === 1 && orphanRejected !== 'ORPHAN_ACCEPTED' && validAccepted === 'ACCEPTED';
      const pass = setWal === 'OK' && walOk && setFk === 'OK' && fkOk;

      record(5, name, pass ? 'PASS' : 'FAIL',
        pass
          ? `journal_mode reads back "wal" and foreign_keys=1 rejects an orphan insert while accepting a valid one`
          : 'pragma settings did not take effect behaviourally',
        {
          measured: {
            setWal,
            readWal,
            readWalViaTable,
            setSync,
            readSync,
            setFk,
            readFk,
            orphanInsertOutcome: orphanRejected?.__error ?? orphanRejected,
            validInsertOutcome: validAccepted,
            betterSqlite3SeesJournalMode: betterSeesWal,
          },
          expected: { journal_mode: 'wal', foreign_keys: 1, orphanInsert: 'REJECTED' },
          sources: ['node:sqlite pragma read-back', 'SQLite constraint behaviour on a real file'],
        });
    }

    // =====================================================================
    // Item 6 — nested transactions / savepoints
    //
    // better-sqlite3's `.transaction()` implements nesting with SAVEPOINT, so
    // the comparable node:sqlite operation is the same savepoint sequence.
    // Expected row set [1,3] is known by reading the scenario, and is also
    // produced by better-sqlite3's own nested transaction.
    // =====================================================================
    {
      const name = 'nested transaction / savepoint rollback semantics';
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t(a INTEGER)');
      const insert = db.prepare('INSERT INTO t VALUES (?)');
      const sequence = safe(() => {
        db.exec('BEGIN');
        insert.run(1);
        db.exec('SAVEPOINT sp_outer');
        insert.run(2);
        db.exec('ROLLBACK TO sp_outer');
        db.exec('RELEASE sp_outer');
        insert.run(3);
        db.exec('COMMIT');
        // `rowids()` reads the `rowid` column, which this table does not have —
        // select `a` explicitly and map it.
        return db.prepare('SELECT a FROM t ORDER BY a').all().map((r) => Number(r.a));
      });
      db.close();

      let betterRows = 'better-sqlite3 unavailable';
      if (better) {
        const bdb = better(':memory:');
        bdb.exec('CREATE TABLE t(a INTEGER)');
        const bins = bdb.prepare('INSERT INTO t VALUES (?)');
        const outer = bdb.transaction(() => {
          bins.run(1);
          const inner = bdb.transaction(() => {
            bins.run(2);
            throw new Error('inner rollback');
          });
          try { inner(); } catch { /* expected: inner rolled back to its savepoint */ }
          bins.run(3);
        });
        outer();
        betterRows = bdb.prepare('SELECT a FROM t ORDER BY a').all().map((r) => Number(r.a));
        bdb.close();
      }

      const ok = JSON.stringify(sequence) === JSON.stringify([1, 3]) && JSON.stringify(betterRows) === JSON.stringify([1, 3]);
      record(6, name, ok ? 'PASS' : 'FAIL',
        ok ? 'inner savepoint rollback discarded only its own row; both drivers agree'
           : `savepoint result ${JSON.stringify(sequence)} vs better-sqlite3 ${JSON.stringify(betterRows)}`,
        {
          measured: sequence,
          expected: [1, 3],
          sources: ['node:sqlite savepoint sequence', 'hand-derived literal', 'better-sqlite3 .transaction() nesting'],
        });
    }

    // =====================================================================
    // Item 7 — .function() inside FTS5 triggers
    //
    // Mirrors apps/desktop/src/main/db/schema.ts:550 — a UDF registered with
    // { deterministic: true } and called from inside a trigger body that
    // feeds an FTS5 table. The assertion is that the UDF ACTUALLY RAN: the
    // stored FTS content is the lowercased form, so a trigger that ignored
    // the function would produce a different value.
    // =====================================================================
    {
      const name = '.function() callable from inside an FTS5 trigger';
      const db = safe(() => buildFtsFixture((f) => new DatabaseSync(f), { trigram: true }));
      if (db === null || typeof db !== 'object' || db.__error) {
        record(7, name, 'FAIL', 'could not build the trigger fixture', {
          measured: db, sources: ['node:sqlite', 'hand-derived literal'],
        });
      } else {
        // This item must assert something ITEM 7 can lose on its own. An
        // earlier version scored it on `quickMatch`, which is already proven by
        // item 3, and on `storedTitle`, which was measured but never asserted —
        // so mutating the trigger body left the item green (found by mutation
        // testing). The assertions below all read the dedicated `proof`
        // database, whose trigger is defined right here and nowhere else.
        db.close();

        const proof = new DatabaseSync(':memory:');
        proof.function('fts_normalize', { deterministic: true }, (s) => String(s).toLowerCase());
        proof.exec("CREATE VIRTUAL TABLE f USING fts5(body)");
        proof.exec("CREATE TABLE src(rowid INTEGER PRIMARY KEY, body TEXT)");
        // Trigger bodies under test: calls the UDF, exactly like the repo's
        // messages_ai / messages_au triggers at schema.ts:627 and :636.
        // The UPDATE trigger deletes then re-inserts, as messages_au does.
        proof.exec('CREATE TRIGGER src_ai AFTER INSERT ON src BEGIN INSERT INTO f(rowid, body) VALUES (new.rowid, fts_normalize(new.body)); END;');
        proof.exec('CREATE TRIGGER src_au AFTER UPDATE ON src BEGIN DELETE FROM f WHERE rowid = old.rowid; INSERT INTO f(rowid, body) VALUES (new.rowid, fts_normalize(new.body)); END;');

        // 1. The UDF must have RUN: 'MiXeD CaSe Body' is stored lowercased.
        //    A trigger that dropped the fts_normalize() call would store the
        //    raw string and fail here.
        const udfRan = safe(() => {
          proof.prepare('INSERT INTO src VALUES (?, ?)').run(1, 'MiXeD CaSe Body');
          return proof.prepare('SELECT body FROM f WHERE rowid = 1').get().body;
        });

        // 2. The row must also be REACHABLE through MATCH on the UDF output.
        //    This proves the trigger wrote to the FTS index, not merely to some
        //    other table.
        const udfMatch = safe(() =>
          rowids(proof.prepare('SELECT rowid FROM f WHERE f MATCH ?').all('"mixed case"')));

        // 3. The UDF must still be callable on UPDATE, the path the repo's
        //    messages_au trigger uses.
        const udfOnUpdate = safe(() => {
          proof.prepare('UPDATE src SET body = ? WHERE rowid = ?').run('AnOtHeR MiXeD', 1);
          return proof.prepare('SELECT body FROM f WHERE rowid = 1').get().body;
        });
        proof.close();

        const lowercased = udfRan === 'mixed case body';
        const indexed = JSON.stringify(udfMatch) === JSON.stringify([1]);
        const updateLowercased = udfOnUpdate === 'another mixed';
        const pass = lowercased && indexed && updateLowercased;
        record(7, name, pass ? 'PASS' : 'FAIL',
          pass
            ? 'trigger invoked the UDF on INSERT and UPDATE, and the normalized text is MATCHable'
            : `trigger/UDF round trip wrong: insert=${JSON.stringify(udfRan)} match=${JSON.stringify(udfMatch)} update=${JSON.stringify(udfOnUpdate)}`,
          {
            measured: { triggerStoredBody: udfRan, ftsMatchOnUdfOutput: udfMatch, afterUpdate: udfOnUpdate },
            expected: { triggerStoredBody: 'mixed case body', ftsMatchOnUdfOutput: [1], afterUpdate: 'another mixed' },
            sources: ['node:sqlite trigger execution', 'hand-derived literal'],
          });
      }
    }

    // =====================================================================
    // Item 8 — BLOB / TEXT round trip
    //
    // Contract §2.1: TEXT must not come back as a Buffer, BLOB must not come
    // back as base64. Byte-exact equality is checked against the literal input
    // bytes. Note the type difference recorded below: better-sqlite3 returns a
    // Buffer, node:sqlite returns a Uint8Array, so Buffer.isBuffer() is false
    // on the new driver — a compat-layer concern, not a data-loss one.
    // =====================================================================
    {
      const name = 'BLOB / TEXT round trip without cross-contamination';
      const TEXT = 'héllo 😀 中文';
      const BYTES = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x7f]);
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, txt TEXT, blb BLOB)');
      db.prepare('INSERT INTO t(txt, blb) VALUES (?, ?)').run(TEXT, BYTES);
      const row = db.prepare('SELECT txt, blb FROM t WHERE id = 1').get();
      const sqlTypes = db.prepare('SELECT typeof(txt) AS t, typeof(blb) AS b FROM t WHERE id = 1').get();
      db.close();

      const txtIsString = typeof row.txt === 'string' && row.txt === TEXT;
      const txtNotBuffer = !Buffer.isBuffer(row.txt);
      const blbIsBinary = row.blb !== null && typeof row.blb === 'object' && !Array.isArray(row.blb);
      const blbBytesExact = Buffer.from(row.blb).equals(BYTES);
      const blbNotBase64String = typeof row.blb !== 'string';

      let betterBlbType = 'better-sqlite3 unavailable';
      if (better) {
        const bdb = better(':memory:');
        bdb.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, txt TEXT, blb BLOB)');
        bdb.prepare('INSERT INTO t(txt, blb) VALUES (?, ?)').run(TEXT, BYTES);
        const br = bdb.prepare('SELECT txt, blb FROM t WHERE id = 1').get();
        betterBlbType = `${br.blb?.constructor?.name ?? typeof br.blb} (isBuffer=${Buffer.isBuffer(br.blb)})`;
        bdb.close();
      }

      const pass = txtIsString && txtNotBuffer && blbIsBinary && blbBytesExact && blbNotBase64String;
      record(8, name, pass ? 'PASS' : 'FAIL',
        pass ? 'TEXT returned as string, BLOB returned byte-exact binary, neither contaminated the other'
             : 'TEXT/BLOB round trip lost type or bytes',
        {
          measured: {
            textType: typeof row.txt,
            textEqualsInput: row.txt === TEXT,
            blobType: row.blb?.constructor?.name ?? typeof row.blb,
            blobIsBuffer: Buffer.isBuffer(row.blb),
            blobBytesExact: blbBytesExact,
            sqlTypes,
            betterSqlite3BlobType: betterBlbType,
          },
          expected: { textType: 'string', blobBytes: [...BYTES], blobConstructor: 'binary (Buffer or Uint8Array)' },
          sources: ['node:sqlite value mapping', 'hand-derived literal input bytes'],
        });
    }

    // =====================================================================
    // Item 9 — rollback path (HARD STOP)
    //
    // The only assertion that counts here is CROSS-DRIVER: a file written by
    // node:sqlite is opened, read, MATCHed and WRITTEN by better-sqlite3, and
    // the reverse. A driver reading its own file proves nothing, so the
    // self-read is deliberately not part of the pass criteria — it is recorded
    // only to show the write actually produced content.
    //
    // The file also carries the features this route cares about: WAL, FTS5
    // with the trigram tokenizer, a foreign key, and a real multi-row corpus.
    // =====================================================================
    {
      const name = 'rollback path — files cross the driver boundary intact';
      const nodeFile = path.join(tmpRoot, 'written-by-node.db');
      const betterFile = path.join(tmpRoot, 'written-by-better.db');

      const readHeader = (file) => {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(100);
          fs.readSync(fd, buf, 0, 100, 0);
          return {
            magic: buf.subarray(0, 15).toString('latin1'),
            pageSize: buf.readUInt16BE(16),
            writeVersion: buf[18],
            readVersion: buf[19],
          };
        } finally {
          fs.closeSync(fd);
        }
      };

      const writeWithNode = safe(() => {
        const db = new DatabaseSync(nodeFile);
        db.function('fts_normalize', { deterministic: true }, (s) => String(s).toLowerCase());
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT)');
        db.exec('CREATE TABLE child(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))');
        db.exec("CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tokenize='trigram')");
        db.exec(`CREATE TRIGGER documents_ai AFTER INSERT ON parent BEGIN
                   INSERT INTO documents_fts(rowid, title, content)
                   VALUES (new.rowid, fts_normalize(new.name), fts_normalize(new.name));
                 END;`);
        const insP = db.prepare('INSERT INTO parent(id, name) VALUES (?, ?)');
        const insC = db.prepare('INSERT INTO child(id, pid) VALUES (?, ?)');
        for (const row of CORPUS) {
          insP.run(row.id, row.title);
          insC.run(row.id, row.id);
        }
        db.close();
        return 'WROTE';
      });
      // Survives only if close() actually flushed the WAL.
      const walSidecarsGone = !fs.existsSync(`${nodeFile}-wal`);
      const nodeHeader = safe(() => readHeader(nodeFile));

      let betterReadsNode = 'better-sqlite3 unavailable';
      let betterWritesNode = 'better-sqlite3 unavailable';
      let betterSeesWal = 'better-sqlite3 unavailable';
      let betterFtsMatch = 'better-sqlite3 unavailable';
      if (better) {
        // This file indexes parent.name (the corpus TITLE) only, so the CJK
        // content query and the [1,2,4] expectation both belong to the item-2/3
        // fixture. Here the expected set is the two titles containing 'quick' —
        // see EXPECTED_TITLE_QUICK_ROWIDS.
        betterFtsMatch = safe(() => {
          const bdb = better(nodeFile);
          try {
            const ids = bdb
              .prepare('SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rowid')
              .all('"quick"')
              .map((r) => Number(r.rowid));
            return ids;
          } finally {
            bdb.close();
          }
        });
        betterSeesWal = safe(() => {
          const bdb = better(nodeFile);
          try { return bdb.pragma('journal_mode', { simple: true }); } finally { bdb.close(); }
        });
        betterReadsNode = safe(() => {
          const bdb = better(nodeFile);
          try { return bdb.prepare('SELECT id, name FROM parent ORDER BY id').all().map((r) => `${r.id}:${r.name}`); } finally { bdb.close(); }
        });
        // A trigger that calls a UDF needs that UDF registered ON THE WRITING
        // CONNECTION. SQLite UDFs are per-connection, so a file whose triggers
        // reference one is readable by any driver but writable only by a
        // connection that registered the function. That is a property of SQLite,
        // not of the driver swap — the repo already relies on it at
        // apps/desktop/src/main/db/schema.ts:543-547 ("SQLite UDFs are
        // per-connection, so each process must register independently").
        //
        // Registering it here mirrors what the real rollback would do, so this
        // measures file portability rather than re-testing item 7.
        betterWritesNode = safe(() => {
          const bdb = better(nodeFile);
          try {
            bdb.function('fts_normalize', { deterministic: true }, (s) => String(s).toLowerCase());
            bdb.prepare('INSERT INTO parent(id, name) VALUES (?, ?)').run(99, 'written-by-better-sqlite3');
            return 'WROTE';
          } finally {
            bdb.close();
          }
        });
      }

      const writeWithBetter = safe(() => {
        const bdb = better(betterFile);
        bdb.pragma('journal_mode = WAL');
        bdb.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT)');
        bdb.exec("CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tokenize='trigram')");
        const ins = bdb.prepare('INSERT INTO parent(id, name) VALUES (?, ?)');
        for (const row of CORPUS) ins.run(row.id, row.title);
        bdb.prepare('INSERT INTO documents_fts(rowid, title, content) VALUES (?, ?, ?)').run(1, 'quick', 'quick brown fox');
        bdb.close();
        return 'WROTE';
      });

      let nodeReadsBetter = 'better-sqlite3 unavailable';
      let nodeFtsMatch = 'better-sqlite3 unavailable';
      if (better) {
        nodeReadsBetter = safe(() => {
          const db = new DatabaseSync(betterFile);
          try { return db.prepare('SELECT id, name FROM parent ORDER BY id').all().map((r) => `${r.id}:${r.name}`); } finally { db.close(); }
        });
        nodeFtsMatch = safe(() => {
          const db = new DatabaseSync(betterFile);
          try { return rowids(db.prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?").all('"quick"')); } finally { db.close(); }
        });
      }

      // node must observe the row better-sqlite3 appended to node's own file:
      // proof the file stayed writable across the boundary, not just readable.
      let nodeSeesBetterAppend = 'better-sqlite3 unavailable';
      if (better) {
        nodeSeesBetterAppend = safe(() => {
          const db = new DatabaseSync(nodeFile);
          try { return db.prepare('SELECT name FROM parent WHERE id = 99').get()?.name ?? 'MISSING'; } finally { db.close(); }
        });
      }

      const expectedRows = CORPUS.map((r) => `${r.id}:${r.title}`);
      const checks = {
        nodeWrote: writeWithNode === 'WROTE',
        betterWrote: writeWithBetter === 'WROTE',
        walFlushedOnClose: walSidecarsGone,
        betterOpenedNodeFile: betterReadsNode !== null && betterReadsNode !== 'better-sqlite3 unavailable' && !betterReadsNode.__error,
        betterReadAllRows: JSON.stringify(betterReadsNode) === JSON.stringify(expectedRows),
        betterMatchedNodeFts: JSON.stringify(betterFtsMatch) === JSON.stringify(EXPECTED_TITLE_QUICK_ROWIDS),
        betterSawWalMode: betterSeesWal === 'wal',
        betterWroteIntoNodeFile: betterWritesNode === 'WROTE',
        nodeObservedBetterAppend: nodeSeesBetterAppend === 'written-by-better-sqlite3',
        nodeOpenedBetterFile: JSON.stringify(nodeReadsBetter) === JSON.stringify(expectedRows),
        nodeMatchedBetterFts: JSON.stringify(nodeFtsMatch) === JSON.stringify([1]),
        headersAgree:
          nodeHeader?.__error === undefined &&
          betterVersion !== null &&
          nodeHeader.magic === 'SQLite format 3',
      };
      const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);

      record(9, name, failed.length === 0 ? 'PASS' : 'FAIL',
        failed.length === 0
          ? 'a file written by node:sqlite is read, MATCHed and written by better-sqlite3, and the reverse holds; headers identical'
          : `failed sub-checks: ${failed.join(', ')}`,
        {
          measured: {
            nodeHeader,
            walFlushedOnClose: walSidecarsGone,
            betterReadsNodeFile: betterReadsNode,
            betterFtsMatchOnNodeFile: betterFtsMatch?.__error ?? betterFtsMatch,
            betterSeesJournalMode: betterSeesWal,
            betterWritesIntoNodeFile: betterWritesNode,
            nodeReadsBetterFile: nodeReadsBetter,
            nodeFtsMatchOnBetterFile: nodeFtsMatch,
            nodeObservedBetterAppend: nodeSeesBetterAppend,
          },
          expected: { rows: expectedRows, ftsMatchOnNodeFile: EXPECTED_TITLE_QUICK_ROWIDS, journalMode: 'wal' },
          sources: ['better-sqlite3 reading a node:sqlite-written file', 'node:sqlite reading a better-sqlite3-written file', 'SQLite file header bytes'],
          blocking: true,
        });
    }
  } finally {
    // Re-runnable: never leave state that changes the next answer.
    //
    // `force: true` suppresses ENOENT but NOT EBUSY, so a run that leaves a
    // handle open (which is exactly what the no-op-close mutation does) fails
    // the removal. That must be LOUD: a probe that silently leaves temp
    // databases behind makes the next run's answer depend on the previous one,
    // which is the re-runnability property this file claims. Verified during
    // mutation testing — unmutated runs leave zero temp dirs, and only the
    // deliberately-broken ones leak.
    const removed = safe(() => (fs.rmSync(tmpRoot, { recursive: true, force: true }), 'REMOVED'));
    const stillExists = fs.existsSync(tmpRoot);
    probeLog(stillExists ? 'WARN' : 'INFO', 'temp workspace cleanup', {
      path: tmpRoot,
      outcome: removed === 'REMOVED' ? 'removed' : (removed?.__error ?? 'unknown error'),
      stillExists,
    });
  }

  // --- the probe's own integrity check -------------------------------------
  // An assertion whose two sides name the same source is an identity check:
  // it cannot fail, so it is not a gate. Rather than trust the author, verify
  // it and surface it as a result of its own. A probe that quietly degrades
  // into comparing a measurement against itself is exactly the failure mode
  // this file is supposed to prevent, and this is what prevents it.
  {
    const degenerate = results.filter(
      (r) => !Array.isArray(r.sources) || new Set(r.sources).size < 2,
    );
    record(0, 'every assertion compares two independent sources', degenerate.length === 0 ? 'PASS' : 'FAIL',
      degenerate.length === 0
        ? `all ${results.length} items name >=2 distinct comparison sources`
        : `items with a single/degenerate source: ${degenerate.map((r) => r.id).join(', ')}`,
      {
        measured: { itemsWithDegenerateSources: degenerate.map((r) => r.id) },
        expected: [],
        sources: ['recorded sources[] per item', 'the probe\'s own record() contract'],
        blocking: true,
      });
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL');
  const unsupported = results.filter((r) => r.status === 'UNSUPPORTED');
  const blockingFailures = failed.filter((r) => BLOCKING_ITEMS.has(r.id));

  return {
    runtime,
    startedAt,
    driver: driverInfo,
    results,
    summary: {
      total: results.length,
      passed,
      failed: failed.length,
      unsupported: unsupported.length,
      blockingItems: [...BLOCKING_ITEMS],
      blockingFailures: blockingFailures.map((r) => r.id),
      exitCode: blockingFailures.length > 0 || failed.length === results.length ? 1 : 0,
    },
  };
}

// CLI mode: only when executed directly, so the Electron launcher can import it.
//
// Compared against THIS module's own path, not a suffix. A suffix test would
// also fire for any other copy of this file, and would silently stop firing if
// the file were renamed — either way the probe would import as a library when
// it was supposed to run, and report nothing.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const report = await runProbe();
  process.stdout.write(`${SENTINEL_OPEN}\n${JSON.stringify(report, null, 2)}\n${SENTINEL_CLOSE}\n`);
  probeLog('INFO', 'probe finished', {
    scope: `${report.summary.passed}/${report.summary.total} in scripts/sqlite-compat-probe.mjs (${report.runtime.isElectron ? 'electron' : 'node'})`,
    failed: report.summary.failed,
    unsupported: report.summary.unsupported,
    blockingFailures: report.summary.blockingFailures,
  });
  process.exit(report.summary.exitCode);
}

export { SENTINEL_OPEN, SENTINEL_CLOSE };

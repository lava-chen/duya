/**
 * toolApprovalState-grant-scope.test.ts — plan 587 R2.4.
 *
 * The durable store that backs a session's "always allow" grant, and the scope
 * it actually enforces.
 *
 * ## Why this file exists separately from `toolApprovalState.test.ts`
 *
 * The store was not new in R2.4 — plan 498 built it and the bot approval card
 * has always written to it. What changed is that the WORKER path now writes
 * here too, so this file answers a different question from the existing one:
 * not "does the CAS work" but "is the scope this table enforces actually the
 * scope the product claims".
 *
 * ## The claim being checked
 *
 * The worker path's grant is called `allow_for_session` and the plan requires
 * that it be session-scoped rather than process-scoped-by-coincidence. Before
 * R2.4 the worker wrote NO row at all: it recorded the grant in a module-level
 * `Set<string>` keyed by bare tool name (`tool/AppConnectionTool/approvals.ts`),
 * which meant the grant died on worker recycle and had no session in its key at
 * all. The table below is what now backs it, and these tests pin the scope.
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ensureToolApprovalTables,
  listToolApprovalRules,
  upsertToolApprovalRule,
} from './toolApprovalState';

type Db = import('better-sqlite3').Database;

// Same ABI guard as `toolApprovalState.test.ts`: the native binary is shared
// between the Electron and Node runtimes.
let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

function makeDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-scope-test-'));
  const db = new Database(path.join(dir, 'test.db')) as Db;
  ensureToolApprovalTables(db);
  return db;
}

describe.skipIf(!nativeSqliteAvailable)('a session grant is keyed by its session', () => {
  it('round-trips a grant under the session that made it', () => {
    const db = makeDb();
    upsertToolApprovalRule(db, 'session', 'sess-a', 'remote_notion_write');

    expect(listToolApprovalRules(db, 'session', 'sess-a')).toEqual(['remote_notion_write']);
  });

  it('does NOT return another session\'s grant', () => {
    const db = makeDb();
    upsertToolApprovalRule(db, 'session', 'sess-a', 'remote_notion_write');

    // The scope is a COLUMN, so a session that never granted anything reads
    // empty. The pre-R2.4 bare `Set<string>` could not express this at all --
    // it had nowhere to put a session.
    expect(listToolApprovalRules(db, 'session', 'sess-b')).toEqual([]);
  });

  it('keeps a bot grant and a session grant apart when their ids collide', () => {
    const db = makeDb();
    upsertToolApprovalRule(db, 'session', 'shared-id', 'tool_x');
    upsertToolApprovalRule(db, 'bot', 'shared-id', 'tool_y');

    expect(listToolApprovalRules(db, 'session', 'shared-id')).toEqual(['tool_x']);
    expect(listToolApprovalRules(db, 'bot', 'shared-id')).toEqual(['tool_y']);
  });

  it('keeps two sessions\' grants independent in one table', () => {
    const db = makeDb();
    upsertToolApprovalRule(db, 'session', 'sess-a', 'tool_x');
    upsertToolApprovalRule(db, 'session', 'sess-b', 'tool_y');

    expect(listToolApprovalRules(db, 'session', 'sess-a')).toEqual(['tool_x']);
    expect(listToolApprovalRules(db, 'session', 'sess-b')).toEqual(['tool_y']);
  });

  it('is idempotent, so a repeated grant is not a second row', () => {
    const db = makeDb();
    upsertToolApprovalRule(db, 'session', 'sess-a', 'remote_notion_write');
    upsertToolApprovalRule(db, 'session', 'sess-a', 'remote_notion_write');

    expect(listToolApprovalRules(db, 'session', 'sess-a')).toEqual(['remote_notion_write']);
  });
});

describe.skipIf(!nativeSqliteAvailable)('the grant outlives the process that made it', () => {
  it('a second connection to the same database sees the grant', () => {
    // This is what a worker recycle is, from the store's point of view: the
    // process holding the first handle is gone, the file is not. Before R2.4
    // the grant was only ever in the first process's memory, so this read
    // returned empty and the user was asked again for a tool they had already
    // granted for the whole session.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-recycle-'));
    const file = path.join(dir, 'test.db');

    const before = new Database(file) as Db;
    ensureToolApprovalTables(before);
    upsertToolApprovalRule(before, 'session', 'sess-1', 'remote_notion_write');
    before.close();

    // The "recycled worker": a brand new connection, no in-process state.
    const after = new Database(file) as Db;
    expect(listToolApprovalRules(after, 'session', 'sess-1')).toEqual(['remote_notion_write']);
    after.close();
  });

  it('a recycled worker does not inherit a grant from a DIFFERENT session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-recycle-'));
    const file = path.join(dir, 'test.db');

    const first = new Database(file) as Db;
    ensureToolApprovalTables(first);
    upsertToolApprovalRule(first, 'session', 'sess-a', 'remote_notion_write');
    first.close();

    const second = new Database(file) as Db;
    expect(listToolApprovalRules(second, 'session', 'sess-b')).toEqual([]);
    second.close();
  });
});

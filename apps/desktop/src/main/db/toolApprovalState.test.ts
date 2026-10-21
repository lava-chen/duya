/**
 * toolApprovalState.test.ts — persistent tool-approval side state (plan 498).
 *
 * Coverage:
 *  - create → get round-trip (pending, deterministic input hash)
 *  - input hash is independent of key insertion order
 *  - resolveToolApproval CAS: pending → approved/denied, always upserts a rule
 *  - double resolve is idempotent (first decision wins)
 *  - consumeApprovedToolApproval: exact tool+hash match, consumes exactly once
 *  - rules upsert/list are scoped per (scope_type, scope_id)
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  consumeApprovedToolApproval,
  createToolApproval,
  ensureToolApprovalTables,
  getToolApproval,
  listToolApprovalRules,
  listToolApprovalsBySession,
  resolveToolApproval,
  toolApprovalInputHash,
} from './toolApprovalState';

type Db = import('better-sqlite3').Database;

// The better-sqlite3 binary is shared between the Electron and Node runtimes
// (ABI swap via scripts/ensure-sqlite-abi.mjs). Skip when the current binary
// does not match the running Node — same guard as mode-state-store.test.ts.
let nativeSqliteAvailable = true;
try {
  const probe = new Database(':memory:');
  probe.close();
} catch {
  nativeSqliteAvailable = false;
}

function makeDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-approval-test-'));
  const db = new Database(path.join(dir, 'test.db')) as Db;
  ensureToolApprovalTables(db);
  return db;
}

const BASE = {
  id: 'perm-1',
  messageId: 'approval-card-perm-1',
  sessionId: 'bot:test',
  scopeType: 'bot' as const,
  scopeId: 'tester',
  toolName: 'send_email',
  toolInput: { to: 'a@b.c', subject: 'hi' },
};

describe.skipIf(!nativeSqliteAvailable)('toolApprovalState', () => {
  it('creates a pending row and round-trips it', () => {
    const db = makeDb();
    const row = createToolApproval(db, BASE);
    expect(row.status).toBe('pending');
    expect(row.decision).toBeNull();
    expect(row.input_hash).toBe(toolApprovalInputHash(BASE.toolInput));
    expect(getToolApproval(db, BASE.id)?.id).toBe(BASE.id);
    expect(listToolApprovalsBySession(db, BASE.sessionId)).toHaveLength(1);
  });

  it('hashes input independent of key order', () => {
    expect(toolApprovalInputHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      toolApprovalInputHash({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(toolApprovalInputHash({ a: 1 })).not.toBe(toolApprovalInputHash({ a: 2 }));
  });

  it('create is idempotent on duplicate id', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    const again = createToolApproval(db, BASE);
    expect(again.created_at).toBe(getToolApproval(db, BASE.id)?.created_at);
    expect(listToolApprovalsBySession(db, BASE.sessionId)).toHaveLength(1);
  });

  it('resolve transitions pending → approved and always upserts the rule', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    const resolved = resolveToolApproval(db, BASE.id, 'always');
    expect(resolved?.claimed).toBe(true);
    expect(resolved?.row.status).toBe('approved');
    expect(resolved?.row.decision).toBe('always');
    expect(resolved?.row.decided_at).toBeGreaterThan(0);
    expect(listToolApprovalRules(db, 'bot', 'tester')).toEqual(['send_email']);
  });

  it('resolve deny transitions to denied without a rule', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    const resolved = resolveToolApproval(db, BASE.id, 'deny');
    expect(resolved?.claimed).toBe(true);
    expect(resolved?.row.status).toBe('denied');
    expect(resolved?.row.decision).toBe('deny');
    expect(listToolApprovalRules(db, 'bot', 'tester')).toEqual([]);
  });

  it('double resolve is idempotent — first decision wins', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    resolveToolApproval(db, BASE.id, 'allow');
    const second = resolveToolApproval(db, BASE.id, 'deny');
    expect(second?.claimed).toBe(false);
    expect(second?.row.status).toBe('approved');
    expect(second?.row.decision).toBe('allow');
    expect(listToolApprovalRules(db, 'bot', 'tester')).toEqual([]);
  });

  it('resolve returns undefined for unknown ids', () => {
    const db = makeDb();
    expect(resolveToolApproval(db, 'missing', 'allow')).toBeUndefined();
  });

  it('consume claims an approved row exactly once, matching tool+hash', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    resolveToolApproval(db, BASE.id, 'allow');
    const hash = toolApprovalInputHash(BASE.toolInput);

    expect(consumeApprovedToolApproval(db, BASE.sessionId, 'send_email', hash)).toBe(true);
    expect(getToolApproval(db, BASE.id)?.status).toBe('consumed');
    // Replay attempts find no approved row anymore.
    expect(consumeApprovedToolApproval(db, BASE.sessionId, 'send_email', hash)).toBe(false);
  });

  it('consume rejects mismatched tool name or input hash', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    resolveToolApproval(db, BASE.id, 'allow');
    expect(consumeApprovedToolApproval(db, BASE.sessionId, 'other_tool', toolApprovalInputHash(BASE.toolInput))).toBe(false);
    expect(consumeApprovedToolApproval(db, BASE.sessionId, 'send_email', 'deadbeef')).toBe(false);
    expect(getToolApproval(db, BASE.id)?.status).toBe('approved');
  });

  it('denied rows can never be consumed', () => {
    const db = makeDb();
    createToolApproval(db, BASE);
    resolveToolApproval(db, BASE.id, 'deny');
    expect(
      consumeApprovedToolApproval(db, BASE.sessionId, 'send_email', toolApprovalInputHash(BASE.toolInput)),
    ).toBe(false);
  });
});

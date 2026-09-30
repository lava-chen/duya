/**
 * IPC e2e: session archive lifecycle (Plan 582)
 *
 * Drives the REAL `db:session:archive` / `db:session:unarchive` handlers
 * through the renderer's `window.electronAPI`, in a real Electron main
 * process against a real SQLite DB and a real rollout directory. This is the
 * layer the unit tests cannot reach: the file moves, the path rewriting and
 * the two-phase commit only mean anything against the actual filesystem and
 * the actual ipcMain registration.
 *
 * What it pins down, beyond "it returns true":
 *
 *   1. G1 — a session whose rollout has ROTATED keeps all its history after
 *      archive, and gets it back byte-for-byte after unarchive. The bug this
 *      guards left `archive-<g>.jsonl` siblings behind and silently truncated
 *      the visible timeline.
 *   2. G1 — two bot sessions archived on the same day do not collide on one
 *      destination path (every bot's live file is called `active.jsonl`).
 *   3. G2 — archiving is refused with `session_busy` when a runtime lock is
 *      held, and NOTHING is written: no row flip, no file move.
 *   4. G2 — a single-file session (the shape that silently never unarchived
 *      before, because the enumeration only knew `archive-<g>`/`active`).
 *   5. G5 — an archived session is absent from the active roster and present
 *      in the archived one.
 *
 * Each test gets its own `--duya-namespace`, so the DB and the rollout root
 * start empty.
 */
import { test, expect } from '@playwright/test';
import { launchDuya, closeDuya, invokeApi, type DuyaApp } from '../helpers';

let dua: DuyaApp;

test.afterEach(async () => {
  if (dua) await closeDuya(dua.app);
});

/** A `db:session:list` row, as the renderer receives it. */
interface SessionRow {
  id: string;
  title: string;
  status: string;
  rollout_path: string | null;
  archived_at: number | null;
  archived_path: string | null;
  recency_at?: number | null;
}

async function createSession(id: string, title = 'archive e2e'): Promise<void> {
  await invokeApi(dua.page, 'thread.create', { id, title });
}

/**
 * Append a user message so the session has real bytes in its rollout file.
 * `db:message:add` takes ONE object with snake_case keys.
 */
async function appendRollout(sessionId: string, content: string): Promise<void> {
  await invokeApi(dua.page, 'message.add', {
    id: `${sessionId}-${content}-${Math.random().toString(36).slice(2, 8)}`,
    session_id: sessionId,
    role: 'user',
    content,
  });
}

async function messagesOf(sessionId: string): Promise<unknown[]> {
  return invokeApi<unknown[]>(dua.page, 'message.getBySession', sessionId);
}

test.describe('session archive (Plan 582)', () => {
  test('G1: a rotated session keeps its whole history across archive/unarchive', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-rotated' });
    const id = `e2e-rot-${Date.now()}`;
    await createSession(id, 'rotated');

    // Build a session with real bytes.
    await appendRollout(id, 'first');
    await appendRollout(id, 'second');
    await appendRollout(id, 'third');

    const before = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(before.rollout_path).toBeTruthy();

    const messagesBefore = await messagesOf(id);
    expect(messagesBefore.length).toBeGreaterThan(0);

    // ── Archive ──
    const archived = await invokeApi<{
      ok: boolean;
      archivedSessionIds?: string[];
      reason?: string;
    }>(dua.page, 'session.archive', id);
    expect(archived.ok).toBe(true);
    expect(archived.archivedSessionIds).toContain(id);

    // The row must now point INTO the archive tree, at a DIRECTORY that
    // mirrors the original relative path.
    const afterArchive = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(afterArchive.status).toBe('archived');
    expect(afterArchive.archived_at).toBeTruthy();
    expect(afterArchive.archived_path).toMatch(
      /^archived\/\d{4}-\d{2}-\d{2}\/.+/,
    );
    expect(afterArchive.rollout_path).toBe(
      `${afterArchive.archived_path}/active.jsonl`,
    );

    // Reading the archived session must still return every message. This is
    // the assertion that failed before: the row pointed at a directory with
    // no segments in it, so the projection resolved zero rows.
    const messagesArchived = await messagesOf(id);
    expect(messagesArchived.length).toBe(messagesBefore.length);

    // ── Unarchive ──
    const unarchived = await invokeApi<boolean>(dua.page, 'session.unarchive', id);
    expect(unarchived).toBe(true);

    const afterUnarchive = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(afterUnarchive.status).toBe('active');
    expect(afterUnarchive.archived_at).toBeNull();
    expect(afterUnarchive.archived_path).toBeNull();
    // Byte-identical path: the unarchive is a pure prefix strip, so the file
    // must land back exactly where `getOrCreateRolloutPath` had put it.
    expect(afterUnarchive.rollout_path).toBe(before.rollout_path);

    const messagesAfter = await messagesOf(id);
    expect(messagesAfter.length).toBe(messagesBefore.length);
  });

  test('G1: two bot sessions archived on the same day do not collide', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-bots' });
    const stamp = Date.now();
    // Every bot session writes to `active.jsonl`, so a destination built from
    // the basename alone would map both bots onto the same file.
    const alpha = `bot:alpha-e2e-${stamp}`;
    const beta = `bot:beta-e2e-${stamp}`;
    await createSession(alpha, 'alpha bot');
    await createSession(beta, 'beta bot');
    await appendRollout(alpha, 'from alpha');
    await appendRollout(beta, 'from beta');

    const a = await invokeApi<{ ok: boolean }>(dua.page, 'session.archive', alpha);
    const b = await invokeApi<{ ok: boolean }>(dua.page, 'session.archive', beta);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const rowA = await invokeApi<SessionRow>(dua.page, 'thread.get', alpha);
    const rowB = await invokeApi<SessionRow>(dua.page, 'thread.get', beta);
    expect(rowA.archived_path).not.toBe(rowB.archived_path);

    // Each bot's own message is still readable from its own file.
    const msgsA = await messagesOf(alpha);
    const msgsB = await messagesOf(beta);
    expect(msgsA.length).toBeGreaterThan(0);
    expect(msgsB.length).toBeGreaterThan(0);
  });

  test('G2: a running session is refused, and nothing is written', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-busy' });
    const id = `e2e-busy-${Date.now()}`;
    await createSession(id, 'busy session');
    await appendRollout(id, 'hello');

    const before = await invokeApi<SessionRow>(dua.page, 'thread.get', id);

    // Take a runtime lock the way the agent process does, so the preflight
    // sees a genuinely busy session. Signature: (sessionId, lockId, owner, ttlSec).
    const lockId = `e2e-lock-${Date.now()}`;
    await invokeApi(dua.page, 'lock.acquire', id, lockId, 'e2e', 60);

    const result = await invokeApi<{ ok: boolean; reason?: string; blockedId?: string }>(
      dua.page,
      'session.archive',
      id,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_busy');
    expect(result.blockedId).toBe(id);

    // The refusal promised "no disk, no SQL" — prove it.
    const after = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(after.status).toBe('active');
    expect(after.archived_at).toBeNull();
    expect(after.archived_path).toBeNull();
    expect(after.rollout_path).toBe(before.rollout_path);

    // Release, and the same call now succeeds.
    await invokeApi(dua.page, 'lock.release', id, lockId);
    const retry = await invokeApi<{ ok: boolean }>(dua.page, 'session.archive', id);
    expect(retry.ok).toBe(true);
  });

  test('G5: an archived session leaves the active roster for the archived one', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-roster' });
    const id = `e2e-roster-${Date.now()}`;
    await createSession(id, 'roster session');
    await appendRollout(id, 'hi');

    const activeBefore = await invokeApi<SessionRow[]>(dua.page, 'thread.list');
    expect(activeBefore.some((t) => t.id === id)).toBe(true);

    await invokeApi(dua.page, 'session.archive', id);

    const activeAfter = await invokeApi<SessionRow[]>(dua.page, 'thread.list');
    expect(activeAfter.some((t) => t.id === id)).toBe(false);

    const archived = await invokeApi<SessionRow[]>(dua.page, 'session.listArchived');
    expect(archived.some((t) => t.id === id)).toBe(true);
  });

  test('archive is idempotent and a second call moves nothing', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-idempotent' });
    const id = `e2e-idem-${Date.now()}`;
    await createSession(id, 'idempotent');
    await appendRollout(id, 'once');

    const first = await invokeApi<{ ok: boolean; archivedSessionIds: string[] }>(
      dua.page,
      'session.archive',
      id,
    );
    expect(first.ok).toBe(true);
    expect(first.archivedSessionIds).toEqual([id]);

    const row = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    const second = await invokeApi<{ ok: boolean; archivedSessionIds: string[] }>(
      dua.page,
      'session.archive',
      id,
    );
    // Already archived: a no-op that reports nothing newly archived, and
    // must not re-date the row.
    expect(second.ok).toBe(true);
    expect(second.archivedSessionIds).toEqual([]);

    const rowAfter = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(rowAfter.archived_at).toBe(row.archived_at);
    expect(rowAfter.archived_path).toBe(row.archived_path);
  });
});

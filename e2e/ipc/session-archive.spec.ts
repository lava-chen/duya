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
 *   1. G1 — a session's history survives archive and comes back on
 *      unarchive, at the original relative path. The path mapping is a pure
 *      prefix strip, so that is the whole claim: anything else would mean
 *      the path had been reconstructed by guesswork.
 *      The ROTATED layout (sibling `archive-<g>.jsonl` segments) is covered
 *      against a real filesystem by `session-archive-whole-session.test.ts`;
 *      reaching the 4MB rotation threshold through the IPC surface would
 *      cost more than it proves.
 *   2. G1 — two bot sessions archived on the same day do not collide on one
 *      destination path (every bot's live file is called `active.jsonl`).
 *   3. G2 — archiving is refused with `session_busy` when a runtime lock is
 *      held, and NOTHING is written: no row flip, no file move. The same
 *      spec then releases the lock and retries, proving the refusal is
 *      about the lock and not about archiving being broken.
 *   4. G5 — an archived session is absent from the active roster and present
 *      in the archived one.
 *   5. Archive is idempotent and a second call does not re-date the row.
 *   6. §8.1 — a row left on the Plan 549 convention is still restored to its
 *      recorded path instead of a bare basename at the rollout root. The row
 *      is put into that shape in place, with a direct SQL write, because
 *      nothing in the running app can produce it.
 *
 * KNOWN HARNESS LIMIT (why §8.1 is not a two-launch test): the boot-time
 * legacy migration needs two launches to observe, and this harness does not
 * carry the core DB across one. A bare close/relaunch — no rewriting, no
 * product code involved — comes back with `sessions`, `message_index` and
 * `session_runtime_locks` all empty, while `meta` carries a boot-2 timestamp
 * for `imported_from_legacy`, i.e. the file was rebuilt rather than truncated.
 * The migration's own logic is covered against a real filesystem and a real
 * schema by `electron/db/core/__tests__/legacy-archive-migration.test.ts`
 * (13 cases, including one that asserts a Plan 549 row reads as EMPTY and
 * that the migration makes its history readable again); what is NOT covered
 * end-to-end is the three-line call in `initCoreDatabase` that runs it.
 *
 * This file is also what caught the `session:unarchive` vs
 * `db:session:unarchive` channel mismatch (Plan 549), which made the
 * renderer's unarchive reject with "No handler registered". The unit tests
 * invoke handlers by their registered name, so by construction they cannot
 * see a name the preload never uses — only a real bridge can.
 *
 * Each test gets its own `--duya-namespace`, so the DB and the rollout root
 * start empty.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchDuya, closeDuya, invokeApi, userDataRootFor, type DuyaApp } from '../helpers';

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
 * `launchDuya` resolves on the first window, but `initCoreDatabase()` runs
 * asynchronously after it, so an early `thread.create` can land before the
 * core stores exist and fail with "Core stores not initialized". Poll the
 * cheapest core-backed channel until it answers instead of guessing a sleep.
 */
async function waitForCoreStores(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await invokeApi(dua.page, 'thread.list');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
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
  test('G1: a single-file session round-trips archive/unarchive losslessly', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-single' });
    await waitForCoreStores();
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
    // mirrors the original relative path. Deliberately NOT asserting the
    // filename: a small session is the single-file layout
    // (`rollout-<stamp>-<id>.jsonl`), while a rotated one is the generation
    // layout (`active.jsonl` + `archive-<g>.jsonl`). Both mirror the same
    // way, and the rotation case is covered against a real filesystem by
    // `session-archive-whole-session.test.ts` — spinning up 4MB of rollout
    // to reach the rotation threshold through the IPC surface would cost
    // more than it proves.
    const afterArchive = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(afterArchive.status).toBe('archived');
    expect(afterArchive.archived_at).toBeTruthy();
    expect(afterArchive.archived_path).toMatch(
      /^archived\/\d{4}-\d{2}-\d{2}\/.+/,
    );
    // The live file lives INSIDE the recorded archive directory, under the
    // same basename it had when active. Basename rather than whole-path
    // comparison: `rollout_path` is stored with the platform separator while
    // the archive mirror normalizes to posix, so the two spellings are not
    // comparable end to end on Windows. Splitting on both separators keeps
    // the assertion platform-honest.
    expect(afterArchive.rollout_path).toMatch(/\.jsonl$/);
    expect(afterArchive.rollout_path!.startsWith(`${afterArchive.archived_path}/`)).toBe(true);
    const basename = (p: string) => p.split(/[\\/]/).pop()!;
    expect(basename(afterArchive.rollout_path!)).toBe(basename(before.rollout_path!));

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
    // The unarchive is a pure prefix strip, so the file lands back at the
    // original relative path. Compared with separators normalized: the
    // pre-archive value was written by `getOrCreateRolloutPath` using the
    // platform separator, while the restored one comes back through
    // `resolveUnarchivedPath`, which is posix. Both name the same file on
    // Windows; only the spelling differs.
    const normalize = (p: string) => p.replace(/\\/g, '/');
    expect(normalize(afterUnarchive.rollout_path!)).toBe(normalize(before.rollout_path!));

    const messagesAfter = await messagesOf(id);
    expect(messagesAfter.length).toBe(messagesBefore.length);
  });

  test('G1: two bot sessions archived on the same day do not collide', async () => {
    dua = await launchDuya({ namespace: 'ipc-archive-bots' });
    await waitForCoreStores();
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
    await waitForCoreStores();
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
    await waitForCoreStores();
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
    await waitForCoreStores();
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


  test('§8.1: a Plan 549 file row unarchives to its recorded path, not the rollout root', async () => {
    const namespace = 'ipc-archive-legacy';
    // Mirrors boot-config: in test mode the rollout root is namespaced under
    // `~/.duya/`, and the core DB sits beside the legacy one in the isolated
    // userData dir. `userDataRootFor` is the same helper `launchDuya` uses, so
    // the two cannot drift.
    const rolloutRoot = path.join(os.homedir(), '.duya', 'test-namespaces', namespace);
    const coreDbPath = path.join(userDataRootFor(namespace), 'databases', 'duya-core.db');

    // A namespace's `config.toml` PERSISTS in `~/.duya/test-namespaces/<ns>/`
    // and pins an absolute `database_path`. Whichever checkout ran the
    // namespace first owns it, so a later run from a different worktree keeps
    // writing to a path the app no longer shares with this one. The spec owns
    // this namespace, so reset it.
    fs.rmSync(path.join(rolloutRoot, 'config.toml'), { force: true });
    fs.rmSync(userDataRootFor(namespace), { recursive: true, force: true });

    dua = await launchDuya({ namespace });
    await waitForCoreStores();
    const id = `e2e-legacy-${Date.now()}`;
    await createSession(id, 'legacy row');
    await appendRollout(id, 'first');
    await appendRollout(id, 'second');

    const before = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    const messagesBefore = await messagesOf(id);
    expect(messagesBefore.length).toBeGreaterThan(0);
    const originalRel = before.rollout_path!.replace(/\\/g, '/');
    const originalAbs = path.join(rolloutRoot, originalRel);
    expect(fs.existsSync(originalAbs)).toBe(true);

    // Let the app archive it for real, so the bucket, the directory shape and
    // the file move are all genuine rather than hand-rolled.
    const archived = await invokeApi<{ ok: boolean }>(dua.page, 'session.archive', id);
    expect(archived.ok).toBe(true);
    const afterArchive = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    const bucket = afterArchive.archived_path!.split('/').slice(0, 2).join('/');
    const liveName = path.posix.basename(afterArchive.rollout_path!);
    const liveAbs = path.join(rolloutRoot, afterArchive.rollout_path!);
    expect(fs.existsSync(liveAbs)).toBe(true);

    // Now put the row back on the Plan 549 shape, in place, while the app is
    // still running: one file at `archived/<date>/<basename>`, and
    // `rollout_path` left on the pre-archive path — which is precisely what the
    // old handler left behind, and the only reason the original location is
    // still recoverable at all. SQLite runs in WAL mode, so a second
    // connection can write while the app holds the database open.
    const legacyRel = `${bucket}/${liveName}`;
    const legacyAbs = path.join(rolloutRoot, legacyRel);
    fs.renameSync(liveAbs, legacyAbs);

    const db = new DatabaseSync(coreDbPath);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare('UPDATE sessions SET rollout_path = ?, archived_path = ? WHERE id = ?').run(
        originalRel,
        legacyRel,
        id,
      );
    } finally {
      db.close();
    }

    // ── Unarchive through the real bridge ───────────────────────────────
    // The boot-time migration is the primary fix, but it needs a second
    // launch to observe, and this harness does not carry the core DB across
    // one (a bare close/relaunch empties `sessions` — see the note in the file
    // header). This exercises the `stat`-based fallback the same handler uses
    // for any row that arrives after that migration ran.
    const unarchived = await invokeApi<boolean>(dua.page, 'session.unarchive', id);
    expect(unarchived).toBe(true);

    // Restored to the recorded path — NOT to the rollout root basename that a
    // bare `archived/<date>/` prefix strip would have produced.
    expect(fs.existsSync(originalAbs)).toBe(true);
    expect(fs.statSync(originalAbs).size).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(rolloutRoot, liveName))).toBe(false);
    expect(fs.existsSync(legacyAbs)).toBe(false);

    const after = await invokeApi<SessionRow>(dua.page, 'thread.get', id);
    expect(after.status).toBe('active');
    expect(after.archived_path).toBeNull();
    expect(after.rollout_path!.replace(/\\/g, '/')).toBe(originalRel);
    expect((await messagesOf(id)).length).toBe(messagesBefore.length);
  });
});
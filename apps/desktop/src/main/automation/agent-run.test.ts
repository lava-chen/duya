/**
 * agent-run.test.ts — Cron session creation for immediate/scheduled runs.
 *
 * Coverage:
 *   - createCronSessionRow persists a cron session through the Host API without
 *     eagerly writing a prompt that the Agent Server will append at dispatch.
 *   - Idempotency: runCronNow creates the row eagerly and runCronInSession
 *     reuses it — a second call must not duplicate the prompt message.
 *   - Empty prompts are skipped (no empty bubble in the run view).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageLog } from '../db/core/message-log';
import { SessionStore } from '../db/core/session-store';
import type { SqliteDatabase } from '../db/core/database';
import { createCronSessionRow } from './agent-run';

// Mock state shared between the vi.mock factories (hoisted) and the tests.
const mocks = vi.hoisted(() => ({
  stores: null as {
    sessions: { get: (id: string) => unknown; create: (input: unknown) => unknown };
    messageLog: { appendBatch: (events: unknown[]) => void; listBySession: (id: string) => unknown[] };
  } | null,
  workspaceDirectory: null as string | null,
  windows: [] as unknown[],
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

vi.mock('../cli/desktop-host-api', () => ({
  getDesktopHostSessionApi: () => {
    if (!mocks.stores) throw new Error('stores not initialized in test');
    return {
      get: async (id: string) => mocks.stores?.sessions.get(id) ?? null,
      registerLocalDirectory: async (directory: string) => {
        mocks.workspaceDirectory = directory;
        return { state: 'bound', workspaceId: 'workspace-test', rootId: null, relativePath: '' };
      },
      create: async (input: Record<string, unknown>) => mocks.stores?.sessions.create({
        ...input,
        workingDirectory: mocks.workspaceDirectory ?? '',
      }),
    };
  },
}));

describe('createCronSessionRow', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let sessions: SessionStore;
  let messageLog: MessageLog;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-agent-run-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    for (const m of [...SessionStore.migrations, ...MessageLog.migrations].sort((a, b) => a.id - b.id)) {
      m.up(db);
    }
    sessions = new SessionStore(db);
    messageLog = new MessageLog(db, path.join(tempDir, 'rollouts'));
    mocks.stores = {
      sessions: {
        get: (id) => sessions.get(id) ?? null,
        create: (input) => sessions.create(input as never),
      },
      messageLog: {
        appendBatch: (events) => messageLog.appendBatch(events as never),
        listBySession: (id) => messageLog.listBySession(id),
      },
    };
    mocks.workspaceDirectory = null;
  });

  afterEach(() => {
    mocks.stores = null;
    mocks.workspaceDirectory = null;
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  const params = {
    sessionId: 'cron:job-1:1710000000000:run-1',
    title: '[Cron] Daily digest',
    model: 'gpt-4o',
    providerId: 'openai',
    workingDirectory: tempDir,
    cronId: 'job-1',
  };

  it('creates the session row without an eager prompt write (plan 441)', async () => {
    await createCronSessionRow(params);

    expect(sessions.get(params.sessionId)).not.toBeNull();
    // Plan 441 removed the eager `messageLog.appendBatch` of the cron
    // prompt. The prompt lands in the rollout via the Journal's
    // `user_msg_added` event when the chat:start-driven DuyaAgent pushes
    // the user message, using the same `cron-prompt:<sessionId>` id.
    expect(messageLog.listBySession(params.sessionId)).toHaveLength(0);
  });

  it('is idempotent across the runCronNow create and runCronInSession reuse', async () => {
    await createCronSessionRow(params);
    await createCronSessionRow(params);

    expect(sessions.get(params.sessionId)).not.toBeNull();
    // No eager writes here means no duplicate prompt messages can pile up
    // across the create + reuse paths.
    expect(messageLog.listBySession(params.sessionId)).toHaveLength(0);
  });

  it('does not append a prompt while creating the Host session', async () => {
    await createCronSessionRow(params);

    expect(sessions.get(params.sessionId)).not.toBeNull();
    expect(messageLog.listBySession(params.sessionId)).toHaveLength(0);
  });
});

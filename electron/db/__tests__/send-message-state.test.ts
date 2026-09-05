/**
 * sendMessage-state — SendMessage card side-state tables (Plan 489 P0.2)
 *
 * Exercises the three side-table helpers against an in-memory better-sqlite3
 * DB: create/update for widget pending state, upsert/update for the cursor-agent
 * run lifecycle, and create/provide for secret-request state, plus the unique
 * message_id and CHECK constraints.
 *
 * Mirrors electron/db/core/__tests__/message-log-source-filter.test.ts — a single
 * node+vitest file (no Electron). better-sqlite3 may not load when DUYA.exe is
 * running (ABI lock on Windows), so the native probe skips the suite cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDatabase } from '../sendMessageState';
import {
  createSendMessageStateTables,
  createWidgetPending,
  updateWidgetResponse,
  upsertCursorAgentRun,
  updateCursorAgentRun,
  createSecretPending,
  markSecretProvided,
} from '../sendMessageState';

/**
 * better-sqlite3 is a single-ABI native module shared by Node (Vitest) and the
 * Electron runtime (see scripts/ensure-sqlite-abi.mjs). When a DUYA.exe is
 * running it locks build/Release/better_sqlite3.node to the Electron ABI. Fall
 * back to a cached Node prebuilt (which can be loaded BY PATH via
 * `nativeBinding`) so this suite still runs under node; only skip when no Node
 * binary is available.
 */
const NODE_PREBUILD_CANDIDATES: readonly string[] = [
  'C:\\Users\\lavachen\\.claude\\jobs\\ab6eff96\\tmp\\bsqlite3\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node',
];

let nativeSqliteAvailable = true;
let nativeBindingPath: string | undefined;
{
  try {
    new Database(':memory:').close();
  } catch {
    nativeBindingPath = NODE_PREBUILD_CANDIDATES.find((p) => {
      try {
        new Database(':memory:', { nativeBinding: p }).close();
        return true;
      } catch {
        return false;
      }
    });
    if (!nativeBindingPath) nativeSqliteAvailable = false;
  }
}

function makeDb(): SqliteDatabase {
  return nativeBindingPath
    ? new Database(':memory:', { nativeBinding: nativeBindingPath })
    : new Database(':memory:');
}

const SESSION = 'bot:test:sid';
const NOW = 1725500000000;

interface WidgetRow {
  status: string;
  custom_answer: string | null;
  answered_at: number | null;
  created_at: number;
}

interface CursorRunRow {
  status: string;
  bc_id: string;
  updated_at: number;
}

interface HostSecretRow {
  status: string;
  label: string;
  connector: string;
  field: string;
  provided_at: number | null;
}

describe.skipIf(!nativeSqliteAvailable)('sendMessageState helper (in-memory sqlite)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = makeDb();
    createSendMessageStateTables(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('widget_response_pending', () => {
    it('creates a pending row and answers it', () => {
      createWidgetPending(db, {
        id: 'w1',
        messageId: 'msg-w1',
        sessionId: SESSION,
        botAgentId: 'bot-a',
        prompt: 'Deploy?',
        widgetJson: JSON.stringify({ prompt: 'Deploy?', options: [{ label: 'Yes' }] }),
        createdAt: NOW,
      });

      let row = db.prepare('SELECT * FROM widget_response_pending WHERE message_id = ?').get('msg-w1') as
        | WidgetRow
        | undefined;
      expect(row?.status).toBe('pending');
      expect(row?.custom_answer).toBeNull();
      expect(row?.answered_at).toBeNull();
      expect(row?.created_at).toBe(NOW);

      updateWidgetResponse(db, {
        messageId: 'msg-w1',
        status: 'answered',
        customAnswer: 'Yes, deploy now',
        answeredAt: NOW + 1000,
      });

      row = db.prepare('SELECT * FROM widget_response_pending WHERE message_id = ?').get('msg-w1') as WidgetRow;
      expect(row.status).toBe('answered');
      expect(row.custom_answer).toBe('Yes, deploy now');
      expect(row.answered_at).toBe(NOW + 1000);
    });

    it('allows dismissing without a custom answer', () => {
      createWidgetPending(db, {
        id: 'w2',
        messageId: 'msg-w2',
        sessionId: SESSION,
        botAgentId: 'bot-a',
        prompt: 'Proceed?',
        widgetJson: '{}',
        createdAt: NOW,
      });
      updateWidgetResponse(db, { messageId: 'msg-w2', status: 'dismissed' });
      const row = db.prepare('SELECT status FROM widget_response_pending WHERE message_id = ?').get('msg-w2') as {
        status: string;
      };
      expect(row.status).toBe('dismissed');
    });

    it('enforces a unique message_id', () => {
      const input = {
        id: 'w3',
        messageId: 'msg-w3',
        sessionId: SESSION,
        botAgentId: 'bot-a',
        prompt: 'Dupe?',
        widgetJson: '{}',
        createdAt: NOW,
      };
      createWidgetPending(db, input);
      expect(() => createWidgetPending(db, { ...input, id: 'w3b' })).toThrow();
    });
  });

  describe('cursor_cloud_agent_run', () => {
    it('upserts a run and transitions through lifecycle', () => {
      upsertCursorAgentRun(db, {
        id: 'c1',
        messageId: 'msg-c1',
        sessionId: SESSION,
        bcId: 'bc-123',
        status: 'pending',
        createdAt: NOW,
        updatedAt: NOW,
      });
      let row = db.prepare('SELECT * FROM cursor_cloud_agent_run WHERE message_id = ?').get('msg-c1') as CursorRunRow;
      expect(row.status).toBe('pending');
      expect(row.bc_id).toBe('bc-123');

      updateCursorAgentRun(db, { messageId: 'msg-c1', status: 'running', updatedAt: NOW + 500 });
      row = db.prepare('SELECT * FROM cursor_cloud_agent_run WHERE message_id = ?').get('msg-c1') as CursorRunRow;
      expect(row.status).toBe('running');
      expect(row.updated_at).toBe(NOW + 500);
    });

    it('treats a re-issued card with the same message_id as an upsert (no duplicate)', () => {
      const base = {
        id: 'c2',
        messageId: 'msg-c2',
        sessionId: SESSION,
        bcId: 'bc-1',
        status: 'pending' as const,
        createdAt: NOW,
        updatedAt: NOW,
      };
      upsertCursorAgentRun(db, base);
      upsertCursorAgentRun(db, { ...base, status: 'completed', updatedAt: NOW + 2000 });
      const rows = db.prepare('SELECT COUNT(*) AS n FROM cursor_cloud_agent_run WHERE message_id = ?').get('msg-c2') as {
        n: number;
      };
      expect(rows.n).toBe(1);
    });
  });

  describe('host_pending_secret', () => {
    it('creates a pending secret and marks it provided', () => {
      createSecretPending(db, {
        id: 's1',
        messageId: 'msg-s1',
        sessionId: SESSION,
        label: 'Slack token',
        connector: 'slack',
        field: 'bot_token',
        createdAt: NOW,
      });
      let row = db.prepare('SELECT * FROM host_pending_secret WHERE message_id = ?').get('msg-s1') as HostSecretRow;
      expect(row.status).toBe('pending');
      expect(row.label).toBe('Slack token');
      expect(row.connector).toBe('slack');
      expect(row.field).toBe('bot_token');
      expect(row.provided_at).toBeNull();

      markSecretProvided(db, { messageId: 'msg-s1', status: 'provided', providedAt: NOW + 500 });
      row = db.prepare('SELECT * FROM host_pending_secret WHERE message_id = ?').get('msg-s1') as HostSecretRow;
      expect(row.status).toBe('provided');
      expect(row.provided_at).toBe(NOW + 500);
    });

    it('rejects an invalid status via the CHECK constraint', () => {
      createSecretPending(db, {
        id: 's2',
        messageId: 'msg-s2',
        sessionId: SESSION,
        label: 'Key',
        connector: 'stripe',
        field: 'api_key',
        createdAt: NOW,
      });
      expect(() =>
        markSecretProvided(db, { messageId: 'msg-s2', status: 'bogus' as never }),
      ).toThrow();
    });
  });
});
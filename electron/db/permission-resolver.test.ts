/**
 * permission-resolver.test.ts - electron 端 resolver 单元测试
 *
 * 用真实 better-sqlite3 + 内存模式验证:
 *   - 普通 new + settings=bypass → full_access
 *   - 普通 new + explicit=auto + settings=bypass → auto (override 优先)
 *   - 派生 + parent=default + settings=bypass → default (不升权)
 *   - 派生 + parent=full_access + settings=default → full_access
 *   - 派生 + parent 不存在 + settings=bypass → auto (降级到新装默认)
 *   - 派生 + explicit=default (untrusted) → 忽略 explicit, 走父
 *   - 派生 + explicit=bypass (trusted) → bypass (trusted override 允许)
 *   - 派生 + 父.profile=garbage + settings=bypass → auto (parent profile 非法, 降级到新装默认)
 *
 * DEFAULT_PROFILE 自 0.x.y 起为 'auto' (YOLO), 与新安装默认一致.
 *
 * Plan 328 Phase 5: parent permission_profile now reads from the core
 * SessionStore (via getCoreStoresOrNull) instead of the legacy
 * chat_sessions table. The settings table still lives on the legacy DB.
 * This test mocks both connections:
 *   - getDatabase → legacy in-memory DB (settings table only)
 *   - getCoreStoresOrNull → real SessionStore over an in-memory core DB
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionStore, type SqliteDatabase } from './core';

// Shared singletons for the two mocked modules. `vi.hoisted` guarantees
// the mock factory closures (also hoisted) see the same objects as the
// test bodies, regardless of import evaluation order.
const mocks = vi.hoisted(() => ({
  // Legacy DB — only the `settings` table (readDefaultFromSettings still
  // reads it; not migrated in Plan 328).
  testDb: null as Database.Database | null,
  // Core DB + SessionStore — for parent-session lookups via
  // getCoreStoresOrNull() in readParentProfileOrDefault.
  coreDb: null as SqliteDatabase | null,
  sessionStore: null as SessionStore | null,
}));

// Mock getDatabase BEFORE importing resolver — returns the legacy DB.
vi.mock('./connection', () => ({
  getDatabase: () => mocks.testDb,
}));

// Mock getCoreStoresOrNull BEFORE importing resolver — returns a real
// SessionStore backed by an in-memory core database so the resolver's
// `stores.sessions.get(parentSessionId)` reads actual fixture rows
// instead of always falling through to DEFAULT_PROFILE.
vi.mock('./core-connection', () => ({
  getCoreStoresOrNull: () =>
    mocks.sessionStore ? { sessions: mocks.sessionStore } : null,
}));

import { resolvePermissionProfile } from './permission-resolver';

function initLegacySchema(db: Database.Database): void {
  // Only the `settings` table lives on the legacy DB now — parent
  // sessions are read from the core SessionStore, so `chat_sessions`
  // is no longer needed here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function initCoreSchema(db: SqliteDatabase): SessionStore {
  for (const m of SessionStore.migrations) m.up(db);
  return new SessionStore(db);
}

function insertSession(
  store: SessionStore,
  id: string,
  profile: string | null,
  parentId: string | null = null,
): void {
  // SessionStore.create uses `permissionMode ?? 'default'`, so passing
  // `undefined` (null profile) yields the schema default; passing `''`
  // or `'garbage'` stores the literal string for the resolver to reject.
  store.create({
    id,
    permissionMode: profile ?? undefined,
    parentSessionId: parentId,
  });
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function clearSetting(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

describe('resolvePermissionProfile', () => {
  let testDb: Database.Database;
  let coreDb: SqliteDatabase;
  let sessionStore: SessionStore;

  beforeEach(() => {
    mocks.testDb = new Database(':memory:');
    testDb = mocks.testDb;
    initLegacySchema(testDb);

    mocks.coreDb = new Database(':memory:') as unknown as SqliteDatabase;
    coreDb = mocks.coreDb;
    sessionStore = initCoreSchema(coreDb);
    mocks.sessionStore = sessionStore;
  });

  afterEach(() => {
    testDb.close();
    coreDb.close();
    mocks.testDb = null;
    mocks.coreDb = null;
    mocks.sessionStore = null;
  });

  describe('普通新 session (parentSessionId 为空)', () => {
    it('settings=bypass → full_access', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      expect(resolvePermissionProfile(undefined, undefined)).toBe('full_access');
    });

    it('settings=auto → auto', () => {
      setSetting(testDb, 'permissionMode', 'auto');
      expect(resolvePermissionProfile(undefined, undefined)).toBe('auto');
    });

    it('settings=default → default', () => {
      setSetting(testDb, 'permissionMode', 'default');
      expect(resolvePermissionProfile(undefined, undefined)).toBe('default');
    });

    it('settings 未设置 → auto (新安装默认)', () => {
      expect(resolvePermissionProfile(undefined, undefined)).toBe('auto');
    });

    it('explicit=auto 优先 settings=bypass', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      expect(resolvePermissionProfile('auto', undefined)).toBe('auto');
    });

    it('explicit=full_access 优先 settings=auto', () => {
      setSetting(testDb, 'permissionMode', 'auto');
      expect(resolvePermissionProfile('full_access', undefined)).toBe('full_access');
    });

    it('explicit=garbage 被忽略, 走 settings', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      expect(resolvePermissionProfile('garbage', undefined)).toBe('full_access');
    });

    it('explicit=default 优先 settings=auto (显式 default)', () => {
      setSetting(testDb, 'permissionMode', 'auto');
      expect(resolvePermissionProfile('default', undefined)).toBe('default');
    });
  });

  describe('派生 session (parentSessionId 有值, 关键安全规则)', () => {
    it('parent=default + settings=bypass → child=default (绝不能升权)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      insertSession(sessionStore, 'parent-1', 'default');
      expect(resolvePermissionProfile(undefined, 'parent-1')).toBe('default');
    });

    it('parent=full_access + settings=default → child=full_access (继承)', () => {
      setSetting(testDb, 'permissionMode', 'default');
      insertSession(sessionStore, 'parent-2', 'full_access');
      expect(resolvePermissionProfile(undefined, 'parent-2')).toBe('full_access');
    });

    it('parent 不存在 + settings=bypass → child=auto (新安装默认)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      expect(resolvePermissionProfile(undefined, 'non-existent')).toBe('auto');
    });

    it('parent=auto + settings=bypass → child=auto (继承, 不读 settings)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      insertSession(sessionStore, 'parent-3', 'auto');
      expect(resolvePermissionProfile(undefined, 'parent-3')).toBe('auto');
    });

    it('parent.profile=garbage + settings=bypass → child=auto (parent 非法, 降级到新装默认)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      insertSession(sessionStore, 'parent-4', 'garbage');
      expect(resolvePermissionProfile(undefined, 'parent-4')).toBe('auto');
    });

    it('parent.profile="" (空字符串) + settings=bypass → child=auto (空字符串非法, 降级到新装默认)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      // SessionStore.create stores '' literally (`'' ?? 'default'` is `''`),
      // mirroring the old raw-SQL behavior where empty string is treated
      // as invalid by isValidProfile and falls back to DEFAULT_PROFILE.
      insertSession(sessionStore, 'parent-5', '');
      expect(resolvePermissionProfile(undefined, 'parent-5')).toBe('auto');
    });
  });

  describe('派生 session + explicit override', () => {
    it('parent=full_access + explicit=default (untrusted) → child=full_access (忽略 untrusted)', () => {
      insertSession(sessionStore, 'parent-6', 'full_access');
      expect(resolvePermissionProfile('default', 'parent-6')).toBe('full_access');
    });

    it('parent=default + explicit=full_access (untrusted) → child=default (忽略 untrusted)', () => {
      insertSession(sessionStore, 'parent-7', 'default');
      expect(resolvePermissionProfile('full_access', 'parent-7')).toBe('default');
    });

    it('parent=default + explicit=full_access (trusted) → child=full_access (允许 trusted 升权)', () => {
      insertSession(sessionStore, 'parent-8', 'default');
      expect(resolvePermissionProfile('full_access', 'parent-8', { isTrustedOverride: true })).toBe('full_access');
    });

    it('parent=full_access + explicit=default (trusted) → child=default (trusted 降权允许)', () => {
      insertSession(sessionStore, 'parent-9', 'full_access');
      expect(resolvePermissionProfile('default', 'parent-9', { isTrustedOverride: true })).toBe('default');
    });

    it('parent 不存在 + explicit=full_access (trusted) → child=full_access (trusted override 优先)', () => {
      expect(resolvePermissionProfile('full_access', 'non-existent', { isTrustedOverride: true })).toBe('full_access');
    });

    it('parent=default + explicit=garbage (trusted) → child=default (illegal explicit 忽略)', () => {
      insertSession(sessionStore, 'parent-10', 'default');
      expect(resolvePermissionProfile('garbage', 'parent-10', { isTrustedOverride: true })).toBe('default');
    });
  });

  describe('settings 缺失 / DB 错误时的降级', () => {
    it('普通 new + settings 缺失 + 无 explicit → auto (新安装默认)', () => {
      expect(resolvePermissionProfile(undefined, undefined)).toBe('auto');
    });

    it('settings 行 value="" → default (行存在但值非法, 走 settingsModeToProfile 安全降级)', () => {
      setSetting(testDb, 'permissionMode', '');
      expect(resolvePermissionProfile(undefined, undefined)).toBe('default');
    });
  });
});

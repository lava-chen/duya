/**
 * permission-resolver.test.ts - electron 端 resolver 单元测试
 *
 * 用真实 better-sqlite3 + 内存模式验证:
 *   - 普通 new + settings=bypass → full_access
 *   - 普通 new + explicit=auto + settings=bypass → auto (override 优先)
 *   - 派生 + parent=default + settings=bypass → default (不升权)
 *   - 派生 + parent=full_access + settings=default → full_access
 *   - 派生 + parent 不存在 + settings=bypass → default (fail closed)
 *   - 派生 + explicit=default (untrusted) → 忽略 explicit, 走父
 *   - 派生 + explicit=bypass (trusted) → bypass (trusted override 允许)
 *   - 派生 + 父.profile=garbage + settings=bypass → default (parent profile 非法, fail closed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock getDatabase BEFORE importing resolver
let testDb: Database.Database;

vi.mock('./connection', () => ({
  getDatabase: () => testDb,
}));

import { resolvePermissionProfile } from './permission-resolver';

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      mode TEXT NOT NULL DEFAULT 'code',
      permission_profile TEXT NOT NULL DEFAULT 'default',
      provider_id TEXT NOT NULL DEFAULT 'env',
      context_summary TEXT NOT NULL DEFAULT '',
      context_summary_updated_at INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,
      agent_profile_id TEXT DEFAULT NULL,
      parent_id TEXT REFERENCES chat_sessions(id),
      agent_type TEXT NOT NULL DEFAULT 'main',
      agent_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function insertSession(db: Database.Database, id: string, profile: string | null, parentId: string | null = null): void {
  db.prepare(
    'INSERT INTO chat_sessions (id, permission_profile, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, profile, parentId, Date.now(), Date.now());
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function clearSetting(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

describe('resolvePermissionProfile', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
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

    it('settings 未设置 → default (fail closed)', () => {
      expect(resolvePermissionProfile(undefined, undefined)).toBe('default');
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
      insertSession(testDb, 'parent-1', 'default');
      expect(resolvePermissionProfile(undefined, 'parent-1')).toBe('default');
    });

    it('parent=full_access + settings=default → child=full_access (继承)', () => {
      setSetting(testDb, 'permissionMode', 'default');
      insertSession(testDb, 'parent-2', 'full_access');
      expect(resolvePermissionProfile(undefined, 'parent-2')).toBe('full_access');
    });

    it('parent 不存在 + settings=bypass → child=default (fail closed)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      expect(resolvePermissionProfile(undefined, 'non-existent')).toBe('default');
    });

    it('parent=auto + settings=bypass → child=auto (继承, 不读 settings)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      insertSession(testDb, 'parent-3', 'auto');
      expect(resolvePermissionProfile(undefined, 'parent-3')).toBe('auto');
    });

    it('parent.profile=garbage + settings=bypass → child=default (parent 非法, fail closed)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      insertSession(testDb, 'parent-4', 'garbage');
      expect(resolvePermissionProfile(undefined, 'parent-4')).toBe('default');
    });

    it('parent.profile="" (空字符串) + settings=bypass → child=default (空字符串非法, fail closed)', () => {
      setSetting(testDb, 'permissionMode', 'bypass');
      // 模拟 DB 端返回空字符串 (与 NULL 在 resolver 中同样被视为非法)
      testDb.prepare(
        'INSERT INTO chat_sessions (id, permission_profile, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run('parent-5', '', Date.now(), Date.now());
      expect(resolvePermissionProfile(undefined, 'parent-5')).toBe('default');
    });
  });

  describe('派生 session + explicit override', () => {
    it('parent=full_access + explicit=default (untrusted) → child=full_access (忽略 untrusted)', () => {
      insertSession(testDb, 'parent-6', 'full_access');
      expect(resolvePermissionProfile('default', 'parent-6')).toBe('full_access');
    });

    it('parent=default + explicit=full_access (untrusted) → child=default (忽略 untrusted)', () => {
      insertSession(testDb, 'parent-7', 'default');
      expect(resolvePermissionProfile('full_access', 'parent-7')).toBe('default');
    });

    it('parent=default + explicit=full_access (trusted) → child=full_access (允许 trusted 升权)', () => {
      insertSession(testDb, 'parent-8', 'default');
      expect(resolvePermissionProfile('full_access', 'parent-8', { isTrustedOverride: true })).toBe('full_access');
    });

    it('parent=full_access + explicit=default (trusted) → child=default (trusted 降权允许)', () => {
      insertSession(testDb, 'parent-9', 'full_access');
      expect(resolvePermissionProfile('default', 'parent-9', { isTrustedOverride: true })).toBe('default');
    });

    it('parent 不存在 + explicit=full_access (trusted) → child=full_access (trusted override 优先)', () => {
      expect(resolvePermissionProfile('full_access', 'non-existent', { isTrustedOverride: true })).toBe('full_access');
    });

    it('parent=default + explicit=garbage (trusted) → child=default (illegal explicit 忽略)', () => {
      insertSession(testDb, 'parent-10', 'default');
      expect(resolvePermissionProfile('garbage', 'parent-10', { isTrustedOverride: true })).toBe('default');
    });
  });

  describe('settings 缺失 / DB 错误时的降级', () => {
    it('普通 new + settings 缺失 + 无 explicit → default', () => {
      expect(resolvePermissionProfile(undefined, undefined)).toBe('default');
    });

    it('settings 行 value="" → default (空字符串视作未设置)', () => {
      setSetting(testDb, 'permissionMode', '');
      expect(resolvePermissionProfile(undefined, undefined)).toBe('default');
    });
  });
});

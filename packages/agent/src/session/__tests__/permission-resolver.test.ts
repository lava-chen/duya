/**
 * permission-resolver.test.ts - agent 端 resolver 单元测试
 *
 * 与 electron 端规则相同, 但**不测试** settings 路径 (agent 端无 settings 表).
 * 测试 matrix:
 *   - 普通 new + explicit=full_access → full_access
 *   - 普通 new + explicit=auto → auto
 *   - 普通 new + 无 explicit → auto (新装默认)
 *   - 派生 + parent=default + explicit=full_access (untrusted) → default (忽略 untrusted)
 *   - 派生 + parent=full_access + explicit=default (untrusted) → full_access
 *   - 派生 + parent=default + explicit=full_access (trusted) → full_access
 *   - 派生 + parent 不存在 + 无 explicit → auto (降级到新装默认)
 *   - 派生 + parent.profile=garbage → auto (parent 非法, 降级到新装默认)
 *
 * DEFAULT_PROFILE 自 0.x.y 起为 'auto' (YOLO), 与新安装默认一致.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Mock ./db BEFORE importing resolver
let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getSession: (sessionId: string) => {
    const row = testDb
      .prepare('SELECT permission_profile FROM chat_sessions WHERE id = ?')
      .get(sessionId) as { permission_profile?: string | null } | undefined;
    if (!row) return null;
    return { permission_profile: row.permission_profile };
  },
}));

import { resolveAgentPermissionProfile } from '../permission-resolver.js';

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE chat_sessions (
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
  `);
}

function insertSession(db: Database.Database, id: string, profile: string | null, parentId: string | null = null): void {
  db.prepare(
    'INSERT INTO chat_sessions (id, permission_profile, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, profile, parentId, Date.now(), Date.now());
}

describe('resolveAgentPermissionProfile', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    initSchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('普通 new (无 parentSessionId)', () => {
    it('explicit=full_access → full_access', () => {
      expect(resolveAgentPermissionProfile('full_access', undefined)).toBe('full_access');
    });

    it('explicit=auto → auto', () => {
      expect(resolveAgentPermissionProfile('auto', undefined)).toBe('auto');
    });

    it('explicit=default → default', () => {
      expect(resolveAgentPermissionProfile('default', undefined)).toBe('default');
    });

    it('无 explicit → auto (新装默认)', () => {
      expect(resolveAgentPermissionProfile(undefined, undefined)).toBe('auto');
    });

    it('explicit=garbage → auto (非法忽略, 走新装默认)', () => {
      expect(resolveAgentPermissionProfile('garbage', undefined)).toBe('auto');
    });

    it('agent 端无 settings 路径: 普通 new 不可能升权到 full_access (除显式 explicit)', () => {
      // 与 electron 端行为差异验证: electron 普通 new + settings=bypass → full_access
      // agent 端相同输入 → auto (新装默认), 不读任何全局设置
      expect(resolveAgentPermissionProfile(undefined, undefined)).toBe('auto');
    });
  });

  describe('派生 (parentSessionId 有值)', () => {
    it('parent=default + 无 explicit → default (继承, 不读任何全局设置)', () => {
      insertSession(testDb, 'p1', 'default');
      expect(resolveAgentPermissionProfile(undefined, 'p1')).toBe('default');
    });

    it('parent=full_access + 无 explicit → full_access', () => {
      insertSession(testDb, 'p2', 'full_access');
      expect(resolveAgentPermissionProfile(undefined, 'p2')).toBe('full_access');
    });

    it('parent=auto + 无 explicit → auto', () => {
      insertSession(testDb, 'p3', 'auto');
      expect(resolveAgentPermissionProfile(undefined, 'p3')).toBe('auto');
    });

    it('parent 不存在 → auto (新装默认)', () => {
      expect(resolveAgentPermissionProfile(undefined, 'non-existent')).toBe('auto');
    });

    it('parent.profile=garbage → auto (parent 非法, 降级到新装默认)', () => {
      insertSession(testDb, 'p4', 'garbage');
      expect(resolveAgentPermissionProfile(undefined, 'p4')).toBe('auto');
    });

    it('parent=default + explicit=full_access (untrusted) → default (忽略 untrusted)', () => {
      insertSession(testDb, 'p5', 'default');
      expect(resolveAgentPermissionProfile('full_access', 'p5')).toBe('default');
    });

    it('parent=full_access + explicit=default (untrusted) → full_access', () => {
      insertSession(testDb, 'p6', 'full_access');
      expect(resolveAgentPermissionProfile('default', 'p6')).toBe('full_access');
    });

    it('parent=default + explicit=full_access (trusted) → full_access (trusted 升权允许)', () => {
      insertSession(testDb, 'p7', 'default');
      expect(resolveAgentPermissionProfile('full_access', 'p7', { isTrustedOverride: true })).toBe('full_access');
    });

    it('parent=full_access + explicit=default (trusted) → default', () => {
      insertSession(testDb, 'p8', 'full_access');
      expect(resolveAgentPermissionProfile('default', 'p8', { isTrustedOverride: true })).toBe('default');
    });

    it('parent 不存在 + explicit=full_access (trusted) → full_access', () => {
      expect(resolveAgentPermissionProfile('full_access', 'non-existent', { isTrustedOverride: true })).toBe('full_access');
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionStore, type CoreSession, type SessionCreateInput } from '../session-store';
import type { SqliteDatabase } from '../database';

describe('SessionStore', () => {
  let tempDir: string;
  let db: SqliteDatabase;
  let store: SessionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-session-test-'));
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    for (const m of SessionStore.migrations) m.up(db);
    store = new SessionStore(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function createInput(id: string, overrides: Partial<SessionCreateInput> = {}): SessionCreateInput {
    return {
      id,
      createdAt: Date.UTC(2026, 7, 6, 12, 0, 0),
      updatedAt: Date.UTC(2026, 7, 6, 12, 0, 0),
      ...overrides,
    };
  }

  // ─── CRUD ───

  it('create + get round-trips all fields with defaults', () => {
    const session = store.create(createInput('s-1', { title: 'My Chat' }));
    expect(session.id).toBe('s-1');
    expect(session.title).toBe('My Chat');
    expect(session.status).toBe('active');
    expect(session.mode).toBe('code');
    expect(session.providerId).toBe('env');
    expect(session.permissionMode).toBe('default');
    expect(session.agentType).toBe('main');
    expect(session.extensions).toEqual({});
    expect(session.rolloutPath).toBeNull();
    expect(session.draft).toBeNull();

    const fetched = store.get('s-1');
    expect(fetched).toEqual(session);
  });

  it('create persists custom field values', () => {
    const session = store.create(createInput('s-1', {
      title: 'Custom',
      workingDirectory: '/path/to/project',
      projectName: 'my-project',
      mode: 'research',
      providerId: 'anthropic',
      agentName: 'researcher',
      extensions: { conductor_canvas_id: 'canvas-1', system_prompt: 'be helpful' },
      rolloutPath: 'sessions/2026/08/06/s-1-rollout.jsonl',
    }));
    expect(session.workingDirectory).toBe('/path/to/project');
    expect(session.projectName).toBe('my-project');
    expect(session.mode).toBe('research');
    expect(session.providerId).toBe('anthropic');
    expect(session.agentName).toBe('researcher');
    expect(session.extensions).toEqual({ conductor_canvas_id: 'canvas-1', system_prompt: 'be helpful' });
    expect(session.rolloutPath).toBe('sessions/2026/08/06/s-1-rollout.jsonl');
  });

  it('get returns null for non-existent id', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('update patches only the specified fields and bumps updated_at', () => {
    const session = store.create(createInput('s-1'));
    const originalUpdatedAt = session.updatedAt;

    // Wait a bit so Date.now() is different
    const future = originalUpdatedAt + 5000;
    const originalGetNow = Date.now;
    Date.now = () => future;
    try {
      store.update('s-1', { title: 'Updated Title', status: 'archived' });
    } finally {
      Date.now = originalGetNow;
    }

    const updated = store.get('s-1')!;
    expect(updated.title).toBe('Updated Title');
    expect(updated.status).toBe('archived');
    expect(updated.updatedAt).toBe(future);
    // Unspecified fields unchanged
    expect(updated.mode).toBe('code');
    expect(updated.providerId).toBe('env');
  });

  it('update with empty patch is a no-op', () => {
    store.create(createInput('s-1'));
    expect(() => store.update('s-1', {})).not.toThrow();
  });

  it('delete removes the session', () => {
    store.create(createInput('s-1'));
    expect(store.get('s-1')).not.toBeNull();
    store.delete('s-1');
    expect(store.get('s-1')).toBeNull();
  });

  // ─── list with filters ───

  it('list returns all sessions sorted by updated_at DESC', () => {
    store.create(createInput('s-1', { updatedAt: 1000 }));
    store.create(createInput('s-2', { updatedAt: 3000 }));
    store.create(createInput('s-3', { updatedAt: 2000 }));
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual(['s-2', 's-3', 's-1']);
  });

  it('list filters by workingDirectory', () => {
    store.create(createInput('s-1', { workingDirectory: '/proj-A' }));
    store.create(createInput('s-2', { workingDirectory: '/proj-B' }));
    store.create(createInput('s-3', { workingDirectory: '/proj-A' }));
    const list = store.list({ workingDirectory: '/proj-A' });
    expect(list.map((s) => s.id).sort()).toEqual(['s-1', 's-3']);
  });

  it('list filters by parentSessionId', () => {
    store.create(createInput('parent'));
    store.create(createInput('child-1', { parentSessionId: 'parent' }));
    store.create(createInput('child-2', { parentSessionId: 'parent' }));
    store.create(createInput('orphan'));
    const list = store.list({ parentSessionId: 'parent' });
    expect(list.map((s) => s.id).sort()).toEqual(['child-1', 'child-2']);
  });

  it('list filters by status', () => {
    store.create(createInput('s-1', { status: 'active' }));
    store.create(createInput('s-2', { status: 'deleted' }));
    store.create(createInput('s-3', { status: 'archived' }));
    const list = store.list({ status: 'active' });
    expect(list.map((s) => s.id)).toEqual(['s-1']);
  });

  it('list filters by excludeModes', () => {
    store.create(createInput('s-1', { mode: 'code' }));
    store.create(createInput('s-2', { mode: 'automation' }));
    store.create(createInput('s-3', { mode: 'research' }));
    const list = store.list({ excludeModes: ['automation'] });
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual(['s-1', 's-3']);
  });

  // ─── draft ───

  it('saveDraft / getDraft round-trip', () => {
    store.create(createInput('s-1'));
    expect(store.getDraft('s-1')).toBe('');
    store.saveDraft('s-1', 'draft text');
    expect(store.getDraft('s-1')).toBe('draft text');
    store.saveDraft('s-1', 'overwritten');
    expect(store.getDraft('s-1')).toBe('overwritten');
  });

  it('getDraft returns empty string for non-existent session', () => {
    expect(store.getDraft('nonexistent')).toBe('');
  });

  // ─── extensions ───

  it('getExtension / setExtension work at key level', () => {
    store.create(createInput('s-1'));
    expect(store.getExtension('s-1', 'conductor_canvas_id')).toBeUndefined();

    store.setExtension('s-1', 'conductor_canvas_id', 'canvas-abc');
    expect(store.getExtension('s-1', 'conductor_canvas_id')).toBe('canvas-abc');

    store.setExtension('s-1', 'system_prompt', 'be helpful');
    expect(store.getExtension('s-1', 'system_prompt')).toBe('be helpful');
    // First key is preserved
    expect(store.getExtension('s-1', 'conductor_canvas_id')).toBe('canvas-abc');
  });

  it('setExtension preserves other keys', () => {
    store.create(createInput('s-1', { extensions: { keyA: 'a', keyB: 'b' } }));
    store.setExtension('s-1', 'keyC', 'c');
    expect(store.getExtension('s-1', 'keyA')).toBe('a');
    expect(store.getExtension('s-1', 'keyB')).toBe('b');
    expect(store.getExtension('s-1', 'keyC')).toBe('c');
  });

  it('getExtension returns undefined for non-existent session', () => {
    expect(store.getExtension('nonexistent', 'key')).toBeUndefined();
  });

  it('setExtension handles object values', () => {
    store.create(createInput('s-1'));
    const obj = { nested: { value: 42 } };
    store.setExtension('s-1', 'config', obj);
    expect(store.getExtension('s-1', 'config')).toEqual(obj);
  });

  // ─── rollout path ───

  it('getRolloutPath / setRolloutPath round-trip', () => {
    store.create(createInput('s-1'));
    expect(store.getRolloutPath('s-1')).toBeNull();

    store.setRolloutPath('s-1', 'sessions/2026/08/06/s-1-rollout.jsonl');
    expect(store.getRolloutPath('s-1')).toBe('sessions/2026/08/06/s-1-rollout.jsonl');
  });

  it('getRolloutPath returns null for non-existent session', () => {
    expect(store.getRolloutPath('nonexistent')).toBeNull();
  });

  // ─── search ───

  it('search hits title', () => {
    store.create(createInput('s-1', { title: 'Bug Fix Discussion' }));
    store.create(createInput('s-2', { title: 'Feature Planning' }));
    const results = store.search('Bug');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search hits project_name', () => {
    store.create(createInput('s-1', { projectName: 'duya-agent' }));
    store.create(createInput('s-2', { projectName: 'other-project' }));
    const results = store.search('duya');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search hits agent_name', () => {
    store.create(createInput('s-1', { agentName: 'researcher' }));
    store.create(createInput('s-2', { agentName: 'coder' }));
    const results = store.search('research');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search matches Chinese substrings', () => {
    store.create(createInput('s-1', { title: '关于性能优化的讨论' }));
    store.create(createInput('s-2', { title: '其他话题' }));
    const results = store.search('性能');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search excludes soft-deleted sessions', () => {
    store.create(createInput('s-1', { title: 'Bug Fix', status: 'deleted' }));
    store.create(createInput('s-2', { title: 'Bug Report', status: 'active' }));
    const results = store.search('Bug');
    expect(results.map((s) => s.id)).toEqual(['s-2']);
  });

  it('search escapes % literal so it does not act as wildcard', () => {
    store.create(createInput('s-1', { title: '50% off sale' }));
    store.create(createInput('s-2', { title: 'something else' }));
    // Searching for '%' literally should only match s-1, not everything
    const results = store.search('%');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search escapes _ literal so it does not act as single-char wildcard', () => {
    store.create(createInput('s-1', { title: 'a_b' }));
    store.create(createInput('s-2', { title: 'aXb' }));
    // Searching for 'a_b' literally should only match s-1, not s-2
    const results = store.search('a_b');
    expect(results.map((s) => s.id)).toEqual(['s-1']);
  });

  it('search respects limit', () => {
    for (let i = 0; i < 5; i++) {
      store.create(createInput(`s-${i}`, { title: `Bug ${i}` }));
    }
    const results = store.search('Bug', 2);
    expect(results).toHaveLength(2);
  });
});

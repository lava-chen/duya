import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentProfileStore } from '../src/agent-profile-store.js';

describe('AgentProfileStore', () => {
  let db: Database.Database;
  let store: AgentProfileStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        allowed_tools TEXT,
        disallowed_tools TEXT,
        prompt_system TEXT,
        prompt_profile TEXT,
        default_model TEXT,
        profile_kind TEXT NOT NULL DEFAULT 'main',
        user_visible INTEGER NOT NULL DEFAULT 1,
        is_preset INTEGER NOT NULL DEFAULT 0,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    store = new AgentProfileStore(db);
  });

  afterEach(() => db.close());

  it('creates and lists profiles using the existing persisted row shape', () => {
    const created = store.create({
      id: 'custom',
      name: 'Custom',
      allowed_tools: ['read_file'],
      prompt_profile: { disableSections: ['memory'] },
    }, 100);

    expect(created).toMatchObject({
      id: 'custom',
      name: 'Custom',
      allowed_tools: '["read_file"]',
      prompt_profile: '{"disableSections":["memory"]}',
      profile_kind: 'main',
      user_visible: 1,
      is_preset: 0,
      is_enabled: 1,
      created_at: 100,
      updated_at: 100,
    });
    expect(store.list()).toEqual([created]);
    expect(store.get('missing')).toBeNull();
  });

  it('updates only supplied fields and preserves nullable JSON encoding', () => {
    store.create({ id: 'custom', name: 'Before', description: 'keep' }, 100);

    const updated = store.update('custom', {
      name: 'After',
      description: null,
      prompt_profile: { enableSections: ['rules'] },
      is_enabled: false,
    }, 200);

    expect(updated).toMatchObject({
      name: 'After',
      description: null,
      prompt_profile: '{"enableSections":["rules"]}',
      is_enabled: 0,
      updated_at: 200,
    });
  });

  it('refuses deleting presets and deletes custom profiles', () => {
    store.create({ id: 'preset', name: 'Preset', is_preset: true });
    store.create({ id: 'custom', name: 'Custom' });

    expect(() => store.delete('preset')).toThrow('Cannot delete preset agent profiles');
    expect(store.delete('custom')).toBe(true);
    expect(store.delete('missing')).toBe(false);
  });
});

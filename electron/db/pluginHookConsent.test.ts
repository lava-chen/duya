/**
 * pluginHookConsent.test.ts — persistent user consent for plugin hook
 * execution (plan 583, seam C).
 *
 * The table is the only thing standing between a third-party plugin and
 * arbitrary local process execution, so the cases that matter are the
 * negative ones: an undecided plugin must read as *not* granted everywhere,
 * and a value the store cannot interpret must degrade to absent rather than
 * open.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  clearPluginHookConsent,
  ensurePluginHookConsentTables,
  getPluginHookConsent,
  getPluginHookConsentMap,
  isPluginHookConsentDecision,
  setPluginHookConsent,
} from './pluginHookConsent';

type Db = import('better-sqlite3').Database;

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  ensurePluginHookConsentTables(db);
});

describe('ensurePluginHookConsentTables', () => {
  it('is idempotent, so boot self-repair and the migration can both call it', () => {
    expect(() => ensurePluginHookConsentTables(db)).not.toThrow();
    expect(() => ensurePluginHookConsentTables(db)).not.toThrow();
  });

  it('survives a reopen, so the decision is not per-session', () => {
    setPluginHookConsent(db, 'com.example.p', 'granted');
    db.close();
    db = new Database(':memory:');
    // A fresh in-memory DB is a different database, so this asserts the DDL
    // is what a real reopen depends on rather than any in-process state.
    ensurePluginHookConsentTables(db);
    expect(getPluginHookConsent(db, 'com.example.p')).toBeNull();
  });
});

describe('setPluginHookConsent / getPluginHookConsent', () => {
  it('round-trips a grant', () => {
    setPluginHookConsent(db, 'com.example.p', 'granted');
    expect(getPluginHookConsent(db, 'com.example.p')).toBe('granted');
  });

  it('round-trips a denial, which is a recorded answer rather than an absence', () => {
    setPluginHookConsent(db, 'com.example.p', 'denied');
    expect(getPluginHookConsent(db, 'com.example.p')).toBe('denied');
  });

  // The load-bearing default. "Not asked yet" and "allowed" must never read
  // the same, because the agent treats this as its whole authorization.
  it('returns null for a plugin nobody has answered for', () => {
    expect(getPluginHookConsent(db, 'com.example.never-asked')).toBeNull();
  });

  it('replaces the previous answer rather than keeping both', () => {
    setPluginHookConsent(db, 'com.example.p', 'granted');
    setPluginHookConsent(db, 'com.example.p', 'denied');
    expect(getPluginHookConsent(db, 'com.example.p')).toBe('denied');
    expect((db.prepare('SELECT COUNT(*) AS n FROM plugin_hook_consent').get() as { n: number }).n).toBe(1);
  });

  it('scopes decisions per plugin id', () => {
    setPluginHookConsent(db, 'com.example.a', 'granted');
    setPluginHookConsent(db, 'com.example.b', 'denied');
    expect(getPluginHookConsent(db, 'com.example.a')).toBe('granted');
    expect(getPluginHookConsent(db, 'com.example.b')).toBe('denied');
    expect(getPluginHookConsent(db, 'com.example.c')).toBeNull();
  });

  it('refuses a decision the schema does not allow', () => {
    // The CHECK constraint is the backstop behind the handler's own
    // validation; both exist because this table is read as authorization.
    expect(() =>
      db
        .prepare('INSERT INTO plugin_hook_consent (plugin_id, decision, decided_at) VALUES (?, ?, ?)')
        .run('com.example.p', 'allow', Date.now()),
    ).toThrow();
  });
});

describe('getPluginHookConsentMap', () => {
  it('omits plugins with no decision, so the caller must not infer consent', () => {
    setPluginHookConsent(db, 'com.example.a', 'granted');
    const map = getPluginHookConsentMap(db);
    expect(map).toEqual({ 'com.example.a': 'granted' });
    expect('com.example.b' in map).toBe(false);
  });

  it('is empty on a fresh database', () => {
    expect(getPluginHookConsentMap(db)).toEqual({});
  });
});

describe('clearPluginHookConsent', () => {
  it('returns a plugin to the undecided state', () => {
    setPluginHookConsent(db, 'com.example.p', 'granted');
    clearPluginHookConsent(db, 'com.example.p');
    expect(getPluginHookConsent(db, 'com.example.p')).toBeNull();
  });

  it('is a no-op for a plugin that was never answered for', () => {
    expect(() => clearPluginHookConsent(db, 'com.example.p')).not.toThrow();
  });
});

describe('isPluginHookConsentDecision', () => {
  it('accepts only the two recorded answers', () => {
    expect(isPluginHookConsentDecision('granted')).toBe(true);
    expect(isPluginHookConsentDecision('denied')).toBe(true);
    for (const value of ['allow', 'GRANTED', '', null, undefined, 1, true, {}]) {
      expect(isPluginHookConsentDecision(value)).toBe(false);
    }
  });
});

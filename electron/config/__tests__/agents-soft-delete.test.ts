/**
 * Plan 493 (Phase D): soft-delete / restore / purge for config-registered bots.
 *
 * Coverage:
 *   1. softDeleteConfigAgent stamps the config + moves the live tree.
 *   2. listConfigAgents hides soft-deleted entries; getLiveConfigAgent returns
 *      undefined for soft-deleted ids; getConfigAgent still surfaces the row
 *      (drawer / IPC needs the deleted metadata).
 *   3. Repeated softDelete on the same id is idempotent (no second directory).
 *   4. restoreConfigAgent moves the tree back and clears the stamps.
 *   5. restoreConfigAgent refuses when the live dir is occupied.
 *   6. listDeletedConfigAgents returns the newest-first ordering.
 *   7. purgeDeletedConfigAgents(dryRun) reports candidates + total bytes
 *      without mutating IO.
 *   8. purgeDeletedConfigAgents physically removes the tree and the config
 *      row once deleted_purge_at is older than `now - olderThanMs`.
 *   9. purgeDeletedConfigAgents skips entries whose purge_at is in the future.
 *  10. Soft-delete survives ConfigStore reload (config.toml is the truth).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import {
  listConfigAgents,
  getConfigAgent,
  getLiveConfigAgent,
  upsertConfigAgent,
  softDeleteConfigAgent,
  restoreConfigAgent,
  listDeletedConfigAgents,
  purgeDeletedConfigAgents,
  isSoftDeletedConfigAgent,
  SOFT_DELETE_GRACE_MS,
} from '../agents';
import { resolveDuyaAgentDir, getBotProfilePath, getBotDeletedDir } from '../agent-paths';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-agents-soft-'));
}

function setupStore(dir: string): ConfigStore {
  const store = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
  return store;
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
  setupStore(dir);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('config agents soft delete (Plan 493, Phase D)', () => {
  it('softDeleteConfigAgent stamps the config and moves the live tree', () => {
    upsertConfigAgent('alpha', { name: 'Alpha' });

    // Seed a profile + sessions dir so the move is exercised on real files.
    const profilePath = getBotProfilePath('alpha', dir);
    fs.writeFileSync(profilePath, JSON.stringify({ name: 'Alpha' }), 'utf8');
    const sessionsDir = path.join(resolveDuyaAgentDir('alpha', dir), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'active.jsonl'), 'placeholder\n', 'utf8');

    const t = Date.now();
    const rec = softDeleteConfigAgent('alpha', { reason: 'cleanup', deletedAt: t });

    expect(rec.id).toBe('alpha');
    expect(rec.deletedAt).toBe(t);
    expect(rec.deletedReason).toBe('cleanup');
    expect(rec.deletedPurgeAt).toBe(t + SOFT_DELETE_GRACE_MS);

    // Live tree is gone; the moved tree is under .deleted/<ts>-alpha/.
    expect(fs.existsSync(resolveDuyaAgentDir('alpha', dir))).toBe(false);
    const movedDir = path.join(getBotDeletedDir(dir), `${t}-alpha`);
    expect(fs.existsSync(movedDir)).toBe(true);
    // profile.json + sessions/active.jsonl moved verbatim.
    expect(fs.existsSync(path.join(movedDir, 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(movedDir, 'sessions', 'active.jsonl'))).toBe(true);

    // Config entry carries the deleted_at stamp.
    const cfg = getConfigAgent('alpha');
    expect(isSoftDeletedConfigAgent(cfg)).toBe(true);
    expect(cfg?.deleted_at).toBe(t);
    expect(cfg?.deleted_reason).toBe('cleanup');
  });

  it('listConfigAgents hides soft-deleted entries; getLiveConfigAgent returns undefined', () => {
    upsertConfigAgent('live-bot', { name: 'Live' });
    upsertConfigAgent('dead-bot', { name: 'Dead' });
    softDeleteConfigAgent('dead-bot');

    const live = listConfigAgents();
    expect(Object.keys(live)).toEqual(['live-bot']);
    expect(getLiveConfigAgent('live-bot')).toBeDefined();
    expect(getLiveConfigAgent('dead-bot')).toBeUndefined();
    // getConfigAgent still surfaces the deleted entry — drawer / IPC need it.
    expect(getConfigAgent('dead-bot')).toBeDefined();
  });

  it('softDelete is idempotent: repeated calls return the same record without creating a second directory', () => {
    upsertConfigAgent('beta', { name: 'Beta' });
    const first = softDeleteConfigAgent('beta', { deletedAt: 1_000 });
    const second = softDeleteConfigAgent('beta', { deletedAt: 9_999 });
    expect(second.deletedAt).toBe(1_000);
    expect(second.deletedPurgeAt).toBe(first.deletedPurgeAt);

    // Exactly one tombstone dir under .deleted/.
    const deletedDir = getBotDeletedDir(dir);
    const entries = fs.readdirSync(deletedDir);
    expect(entries).toEqual(['1000-beta']);
  });

  it('restoreConfigAgent moves the tree back and clears the stamps', () => {
    upsertConfigAgent('gamma', { name: 'Gamma' });
    const profilePath = getBotProfilePath('gamma', dir);
    fs.writeFileSync(profilePath, JSON.stringify({ name: 'Gamma' }), 'utf8');
    softDeleteConfigAgent('gamma', { deletedAt: 2_000 });

    const out = restoreConfigAgent('gamma', { restoredAt: 3_000 });
    expect(out.id).toBe('gamma');
    expect(out.restoredAt).toBe(3_000);

    // Live tree is back, deleted tree is gone.
    expect(fs.existsSync(resolveDuyaAgentDir('gamma', dir))).toBe(true);
    expect(fs.existsSync(path.join(getBotDeletedDir(dir), '2000-gamma'))).toBe(false);

    // profile.json content survived the move.
    expect(JSON.parse(fs.readFileSync(profilePath, 'utf8'))).toEqual({ name: 'Gamma' });

    // Config stamps are cleared.
    const cfg = getConfigAgent('gamma');
    expect(isSoftDeletedConfigAgent(cfg)).toBe(false);
    expect(cfg?.deleted_at).toBeUndefined();
    expect(getLiveConfigAgent('gamma')).toBeDefined();
  });

  it('restoreConfigAgent refuses when the live directory is already occupied', () => {
    upsertConfigAgent('delta', { name: 'Delta' });
    softDeleteConfigAgent('delta', { deletedAt: 5_000 });

    // Operator manually re-creates the live dir with the same name (e.g. a
    // new bot with the same id).
    const liveDir = resolveDuyaAgentDir('delta', dir);
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(path.join(liveDir, 'profile.json'), '{}', 'utf8');

    expect(() => restoreConfigAgent('delta')).toThrow(/already exists/);

    // The tombstone is left in place; the failed restore must NOT delete it.
    expect(fs.existsSync(path.join(getBotDeletedDir(dir), '5000-delta'))).toBe(true);
  });

  it('listDeletedConfigAgents returns newest-first ordering', () => {
    upsertConfigAgent('a', { name: 'A' });
    upsertConfigAgent('b', { name: 'B' });
    softDeleteConfigAgent('a', { deletedAt: 100 });
    softDeleteConfigAgent('b', { deletedAt: 200 });

    const list = listDeletedConfigAgents();
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    expect(list[0].deletedAt).toBe(200);
    expect(list[1].deletedAt).toBe(100);
  });

  it('purgeDeletedConfigAgents dryRun reports candidates + total bytes without mutating IO', () => {
    upsertConfigAgent('epsilon', { name: 'Epsilon' });
    fs.writeFileSync(getBotProfilePath('epsilon', dir), 'x'.repeat(1024), 'utf8');
    softDeleteConfigAgent('epsilon', { deletedAt: 1_000 });

    const result = purgeDeletedConfigAgents({
      now: 1_000 + SOFT_DELETE_GRACE_MS + 1,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.purgedIds).toEqual([]);
    expect(result.candidates.map((c) => c.id)).toEqual(['epsilon']);
    expect(result.totalBytes).toBeGreaterThanOrEqual(1024);

    // Dry-run does not mutate the config or remove the tombstone.
    expect(isSoftDeletedConfigAgent(getConfigAgent('epsilon'))).toBe(true);
    expect(fs.existsSync(path.join(getBotDeletedDir(dir), '1000-epsilon'))).toBe(true);
  });

  it('purgeDeletedConfigAgents physically removes the tree and the config row when the grace period has elapsed', () => {
    upsertConfigAgent('zeta', { name: 'Zeta' });
    fs.writeFileSync(getBotProfilePath('zeta', dir), 'hello', 'utf8');
    softDeleteConfigAgent('zeta', { deletedAt: 1_000 });

    // Still within the grace window — deleted_purge_at is 1_000 + 30d; now
    // is 1_000 + 1_000, well before the purge time, so nothing is purged.
    const inWindow = purgeDeletedConfigAgents({ now: 1_000 + 1_000 });
    expect(inWindow.purgedIds).toEqual([]);
    expect(getConfigAgent('zeta')).toBeDefined();

    // After the purge time (1_000 + 30d) — purges both disk and config.
    const purged = purgeDeletedConfigAgents({
      now: 1_000 + SOFT_DELETE_GRACE_MS + 100,
    });
    expect(purged.purgedIds).toEqual(['zeta']);
    expect(fs.existsSync(path.join(getBotDeletedDir(dir), '1000-zeta'))).toBe(false);
    expect(getConfigAgent('zeta')).toBeUndefined();
  });

  it('purgeDeletedConfigAgents respects olderThanMs as an extra buffer after deleted_purge_at', () => {
    upsertConfigAgent('eta', { name: 'Eta' });
    softDeleteConfigAgent('eta', { deletedAt: 1_000, graceMs: 10_000 });
    // eta deleted_purge_at = 11_000.

    // now = 20_000 (> 11_000): purge_at has passed. With olderThanMs = 0
    // (default), eta WOULD purge. We confirm the default behavior here so
    // the next test can layer an extra buffer on top.
    const withDefault = purgeDeletedConfigAgents({ now: 20_000 });
    expect(withDefault.purgedIds).toContain('eta');
  });

  it('purgeDeletedConfigAgents olderThanMs keeps the bot around for the extra buffer', () => {
    upsertConfigAgent('iota', { name: 'Iota' });
    softDeleteConfigAgent('iota', { deletedAt: 1_000, graceMs: 1_000 });
    // iota deleted_purge_at = 2_000.

    // now = 5_000: purge_at has long passed. With olderThanMs = 100_000,
    // the test requires deleted_purge_at < now - 100_000 (i.e. the purge
    // time is at least 100s in the past). 2_000 < 5_000 - 100_000 → false
    // → iota is kept.
    const skipped = purgeDeletedConfigAgents({ now: 5_000, olderThanMs: 100_000 });
    expect(skipped.purgedIds).toEqual([]);
    expect(getConfigAgent('iota')).toBeDefined();
  });

  it('soft-delete survives a ConfigStore reload (config.toml is the truth)', () => {
    upsertConfigAgent('theta', { name: 'Theta' });
    softDeleteConfigAgent('theta', { deletedAt: 7_000 });

    // Drop the in-memory store and rehydrate from the same config.toml.
    _setConfigStoreForTest(undefined);
    const rehydrated = setupStore(dir);

    // listConfigAgents (the filtered live view) does not see theta.
    expect(listConfigAgents()['theta']).toBeUndefined();

    // listDeletedConfigAgents still sees theta with the same stamps.
    const deleted = listDeletedConfigAgents();
    expect(deleted.find((r) => r.id === 'theta')).toBeDefined();
    expect(deleted.find((r) => r.id === 'theta')!.deletedAt).toBe(7_000);
  });
});
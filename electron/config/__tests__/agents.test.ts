import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { listConfigAgents, listBots, upsertConfigAgent, deleteConfigAgent, allocateBotId, collectTakenBotIds, createConfigAgentUnique, softDeleteConfigAgent, updateBotProfileIdentity } from '../agents';
import { getConfigStore } from '../store-instance';
import { readBotProfile, writeBotProfile } from '../bot-profile';
import { getBotProfilePath, getDuyaAgentsRoot, getBotDeletedDir } from '../agent-paths';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-agents-'));
}

let dir: string;

beforeEach(() => {
  dir = tmpDir();
  const store = new ConfigStore({
    configPath: path.join(dir, 'config.toml'),
    secretsPath: path.join(dir, 'secrets.json'),
  });
  _setConfigStoreForTest(store);
});

afterEach(() => {
  _setConfigStoreForTest(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('config agents write module', () => {
  it('upsertConfigAgent stores an agent that listConfigAgents returns', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    const agents = listConfigAgents();
    expect(agents['foo']).toBeDefined();
    expect(agents['foo']!.name).toBe('Foo');
  });

  it('re-upserting the same id updates rather than errors', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    upsertConfigAgent('foo', { name: 'Foo v2', description: 'updated' });
    const agents = listConfigAgents();
    expect(agents['foo']!.name).toBe('Foo v2');
    expect(agents['foo']!.description).toBe('updated');
    expect(Object.keys(agents)).toHaveLength(1);
  });

  it('upsertConfigAgent persists provider and listBots surfaces it', () => {
    upsertConfigAgent('foo', { name: 'Foo', model: 'glm-4', provider: 'zhipu' });
    expect(listConfigAgents()['foo']!.provider).toBe('zhipu');
    const bot = listBots().find((b) => b.id === 'foo');
    expect(bot?.model).toBe('glm-4');
    expect(bot?.provider).toBe('zhipu');
  });

  it('upsert without provider preserves the binding; an empty string clears it', () => {
    upsertConfigAgent('foo', { name: 'Foo', model: 'glm-4', provider: 'zhipu' });
    upsertConfigAgent('foo', { name: 'Foo v2' });
    expect(listConfigAgents()['foo']!.provider).toBe('zhipu');
    upsertConfigAgent('foo', { name: 'Foo v3', provider: '' });
    expect(listConfigAgents()['foo']!.provider).toBeUndefined();
  });

  it('missing name throws', () => {
    expect(() => upsertConfigAgent('bar', {} as Parameters<typeof upsertConfigAgent>[1])).toThrow(/name is required/);
  });

  it('deleteConfigAgent removes the agent from the list', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    expect(deleteConfigAgent('foo')).toBe(true);
    expect(listConfigAgents()['foo']).toBeUndefined();
  });

  it('deleteConfigAgent returns false for a missing id', () => {
    expect(deleteConfigAgent('nope')).toBe(false);
  });

  // Plan 485 P2.1: first creation seeds agents/<id>/profile.json from config.
  it('seeds profile.json on first creation', () => {
    upsertConfigAgent('foo', { name: 'Foo', description: 'desc' });
    const profile = readBotProfile(getBotProfilePath('foo', dir));
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Foo');
    expect(profile!.description).toBe('desc');
  });

  it('does not overwrite an existing runtime profile on re-upsert (identity wins)', () => {
    // Runtime identity diverges from config (e.g. the model renamed itself).
    const profilePath = getBotProfilePath('foo', dir);
    writeBotProfile(profilePath, { name: 'Foo (renamed)', title: 'T', description: 'runtime desc' });

    upsertConfigAgent('foo', { name: 'Config Foo', description: 'config desc' });
    const agents = listConfigAgents();
    expect(agents['foo']!.name).toBe('Config Foo'); // config update persists

    // But profile.json (runtime identity) is untouched.
    const profile = readBotProfile(profilePath);
    expect(profile!.name).toBe('Foo (renamed)');
    expect(profile!.description).toBe('runtime desc');
  });

  it('upsert of a previously-deleted agent re-seeds (new again)', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    expect(fs.existsSync(getBotProfilePath('foo', dir))).toBe(true);
    deleteConfigAgent('foo'); // hard delete removes the whole runtime tree
    expect(fs.existsSync(getBotProfilePath('foo', dir))).toBe(false);
    // A profile written after the deletion (e.g. restored from backup) is
    // runtime identity and is never overwritten by the config seed.
    writeBotProfile(getBotProfilePath('foo', dir), { name: 'Foo kept', title: '', description: '' });
    upsertConfigAgent('foo', { name: 'Foo v2' });
    const profile = readBotProfile(getBotProfilePath('foo', dir));
    expect(profile!.name).toBe('Foo kept');
  });

  // Plan 483 P1.2 read side — config declaration merged with profile identity.
  it('listBots merges config + profile identity, profile winning for name/description', () => {
    upsertConfigAgent('alpha', { name: 'Config Alpha', description: 'config desc' });
    // Runtime identity diverges (e.g. model renamed itself via update_state).
    writeBotProfile(getBotProfilePath('alpha', dir), {
      name: 'Alpha (renamed)',
      title: 'Researcher',
      description: 'runtime desc',
      avatarColor: 'blue',
    });

    const bots = listBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]!.id).toBe('alpha');
    expect(bots[0]!.name).toBe('Alpha (renamed)');
    expect(bots[0]!.title).toBe('Researcher');
    expect(bots[0]!.description).toBe('runtime desc');
    expect(bots[0]!.avatarColor).toBe('blue');
  });

  it('listBots falls back to config when no profile exists', () => {
    upsertConfigAgent('beta', { name: 'Beta', description: 'no profile' });
    const bots = listBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]!.name).toBe('Beta');
    expect(bots[0]!.description).toBe('no profile');
    expect(bots[0]!.title).toBe('');
  });

  it('first creation seeds the avatar color from the upsert input', () => {
    upsertConfigAgent('gamma', { name: 'Gamma', avatarColor: 'orange' });
    const profile = readBotProfile(getBotProfilePath('gamma', dir));
    expect(profile!.avatarColor).toBe('orange');
  });
});

// Plan 493 follow-up: collision-free bot id allocation (config + disk +
// tombstones) — the renderer only sees live config ids, so the main process
// must be the authoritative uniqueness check.
describe('bot id allocation (collectTakenBotIds / allocateBotId / createConfigAgentUnique)', () => {
  it('collectTakenBotIds sees config ids even without an agents dir', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    expect(collectTakenBotIds(dir).has('foo')).toBe(true);
  });

  it('collectTakenBotIds sees on-disk dirs and .deleted tombstone ids', () => {
    fs.mkdirSync(path.join(getDuyaAgentsRoot(dir), 'live-dir'), { recursive: true });
    const deleted = path.join(getBotDeletedDir(dir), '1700000000000-tomb');
    fs.mkdirSync(deleted, { recursive: true });
    const taken = collectTakenBotIds(dir);
    expect(taken.has('live-dir')).toBe(true);
    expect(taken.has('tomb')).toBe(true);
  });

  it('allocateBotId returns the desired id when free', () => {
    expect(allocateBotId('foo', dir)).toBe('foo');
  });

  it('allocateBotId suffixes when a stale on-disk dir occupies the id', () => {
    fs.mkdirSync(path.join(getDuyaAgentsRoot(dir), 'foo'), { recursive: true });
    const id = allocateBotId('foo', dir);
    expect(id).toMatch(/^foo-[a-z0-9]{6}$/);
  });

  it('allocateBotId avoids ids recovered from .deleted tombstones', () => {
    fs.mkdirSync(path.join(getBotDeletedDir(dir), '1700000000000-foo'), { recursive: true });
    expect(allocateBotId('foo', dir)).toMatch(/^foo-[a-z0-9]{6}$/);
  });

  it('allocateBotId avoids soft-deleted config ids', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    softDeleteConfigAgent('foo', { reason: 'test' });
    expect(allocateBotId('foo', dir)).toMatch(/^foo-[a-z0-9]{6}$/);
  });

  it('allocateBotId keeps a taken long base inside the 63-char limit', () => {
    fs.mkdirSync(path.join(getDuyaAgentsRoot(dir), 'a'.repeat(63)), { recursive: true });
    const id = allocateBotId('a'.repeat(63), dir);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });

  it('createConfigAgentUnique returns the actual id and seeds its profile', () => {
    fs.mkdirSync(path.join(getDuyaAgentsRoot(dir), 'foo'), { recursive: true });
    const { id, config } = createConfigAgentUnique('foo', { name: 'Foo' });
    expect(id).not.toBe('foo');
    expect(config.name).toBe('Foo');
    expect(readBotProfile(getBotProfilePath(id, dir))!.name).toBe('Foo');
  });

  it('deleteConfigAgent removes the whole on-disk tree (hard delete)', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    const agentDir = path.join(getDuyaAgentsRoot(dir), 'foo');
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(deleteConfigAgent('foo')).toBe(true);
    expect(fs.existsSync(agentDir)).toBe(false);
  });

  it('upsertConfigAgent refuses to resurrect a soft-deleted agent', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    softDeleteConfigAgent('foo');
    expect(() => upsertConfigAgent('foo', { name: 'Again' })).toThrow(/soft-deleted/);
  });

  it('listBots hides soft-deleted agents', () => {
    upsertConfigAgent('alpha', { name: 'Alpha' });
    upsertConfigAgent('beta', { name: 'Beta' });
    softDeleteConfigAgent('beta');
    expect(listBots().map((b) => b.id)).toEqual(['alpha']);
  });
});

// ── Plan 502: title seeding + single id minting point ──

describe('Plan 502 (title field + id minting alignment)', () => {
  it('upsertConfigAgent seeds the role title into profile.json', () => {
    upsertConfigAgent('titled', { name: 'Titled', title: 'Ops steward', description: 'd' });
    const profile = readBotProfile(getBotProfilePath('titled', dir));
    expect(profile!.title).toBe('Ops steward');
    expect(profile!.name).toBe('Titled');
    // Title is profile.json ONLY — it must not leak into config.toml.
    expect((listConfigAgents().titled as unknown as Record<string, unknown>).title).toBeUndefined();
  });

  it('upsertConfigAgent seeds an empty title when none is given', () => {
    upsertConfigAgent('plain', { name: 'Plain' });
    expect(readBotProfile(getBotProfilePath('plain', dir))!.title).toBe('');
  });

  it('updateBotProfileIdentity writes and clears the title', () => {
    upsertConfigAgent('foo', { name: 'Foo' });
    updateBotProfileIdentity('foo', { title: 'Night shift' });
    expect(readBotProfile(getBotProfilePath('foo', dir))!.title).toBe('Night shift');
    // Absent input.title preserves the existing value; empty string clears.
    updateBotProfileIdentity('foo', { name: 'Foo renamed' });
    expect(readBotProfile(getBotProfilePath('foo', dir))!.title).toBe('Night shift');
    updateBotProfileIdentity('foo', { title: '' });
    expect(readBotProfile(getBotProfilePath('foo', dir))!.title).toBe('');
  });

  it('listBots surfaces the title for the roster subtitle', () => {
    upsertConfigAgent('foo', { name: 'Foo', title: 'Scout' });
    expect(listBots().find((b) => b.id === 'foo')?.title).toBe('Scout');
  });

  it('createConfigAgentUnique mints a suffixed id from a non-ASCII name (generic base)', () => {
    const { id } = createConfigAgentUnique('bot', { name: '研究员' });
    // slugifyBotIdFromName falls back to the generic `bot` base for
    // non-ASCII names; allocateBotId suffixes it against the taken set.
    expect(id).toMatch(/^bot(-[a-z0-9]{6})?$/);
    expect(id).not.toBe('');
  });
});
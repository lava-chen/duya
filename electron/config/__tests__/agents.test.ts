import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { listConfigAgents, upsertConfigAgent, deleteConfigAgent } from '../agents';
import { readBotProfile, writeBotProfile } from '../bot-profile';
import { getBotProfilePath } from '../agent-paths';

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
    deleteConfigAgent('foo');
    // Deleting the config entry does not remove the profile dir; re-creating
    // with the same id keeps the existing runtime identity file untouched.
    writeBotProfile(getBotProfilePath('foo', dir), { name: 'Foo kept', title: '', description: '' });
    upsertConfigAgent('foo', { name: 'Foo v2' });
    const profile = readBotProfile(getBotProfilePath('foo', dir));
    expect(profile!.name).toBe('Foo kept');
  });
});
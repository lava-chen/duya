import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ConfigStore } from '../store';
import { _setConfigStoreForTest } from '../store-instance';
import { listConfigAgents, upsertConfigAgent, deleteConfigAgent } from '../agents';

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
});
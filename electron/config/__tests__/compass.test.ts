import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from '@iarna/toml';
import { resolveDatabasePathFromConfigToml } from '../compass';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-compass-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('compass', () => {
  it('returns configured database_path from config.toml', () => {
    const cfgPath = path.join(dir, 'config.toml');
    fs.writeFileSync(cfgPath, stringify({ storage: { database_path: '/x/duya-main.db' } }));
    expect(resolveDatabasePathFromConfigToml(cfgPath)).toBe('/x/duya-main.db');
  });

  it('returns default when config.toml missing or storage empty', () => {
    const cfgPath = path.join(dir, 'config.toml');
    expect(resolveDatabasePathFromConfigToml(cfgPath)).toBe('');
    fs.writeFileSync(cfgPath, stringify({ storage: { database_path: '' } }));
    expect(resolveDatabasePathFromConfigToml(cfgPath)).toBe('');
  });
});
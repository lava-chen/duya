import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stringify } from 'yaml';
import { resolveDatabasePathFromConfigYaml } from '../compass';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-compass-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('compass', () => {
  it('returns configured database_path from config.yaml', () => {
    const cfgPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfgPath, stringify({ storage: { database_path: '/x/duya-main.db' } }));
    expect(resolveDatabasePathFromConfigYaml(cfgPath)).toBe('/x/duya-main.db');
  });

  it('returns default when config.yaml missing or storage empty', () => {
    const cfgPath = path.join(dir, 'config.yaml');
    expect(resolveDatabasePathFromConfigYaml(cfgPath)).toBe('');
    fs.writeFileSync(cfgPath, stringify({ storage: { database_path: '' } }));
    expect(resolveDatabasePathFromConfigYaml(cfgPath)).toBe('');
  });
});
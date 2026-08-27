import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readToolExposureConfig } from '../tool-exposure.js';

// Each test gets its own config root, passed explicitly via the injectable
// `configRootOverride` parameter (resolveConfigRoot is fixed to ~/.duya).
let tmpRoot: string;

describe('readToolExposureConfig (plan 452 Phase A)', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-tool-exposure-'));
    delete process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  });

  it('defaults to Direct exposure (onDemandDiscovery: false) without config', () => {
    expect(readToolExposureConfig(tmpRoot).onDemandDiscovery).toBe(false);
  });

  it('reads [tools] on_demand_discovery = true from config.toml', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.toml'),
      '[tools]\non_demand_discovery = true\n',
      'utf-8',
    );
    expect(readToolExposureConfig(tmpRoot).onDemandDiscovery).toBe(true);
  });

  it('keeps the default on malformed config', () => {
    fs.writeFileSync(path.join(tmpRoot, 'config.toml'), 'not [valid toml {{{', 'utf-8');
    expect(readToolExposureConfig(tmpRoot).onDemandDiscovery).toBe(false);
  });

  it('env override wins over config file', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.toml'),
      '[tools]\non_demand_discovery = false\n',
      'utf-8',
    );
    process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY = '1';
    expect(readToolExposureConfig(tmpRoot).onDemandDiscovery).toBe(true);
  });
});

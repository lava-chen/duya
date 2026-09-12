import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readToolExposureConfig,
  mcpExposureToExposeMode,
  type MCPExposureMode,
} from '../tool-exposure.js';

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

  it('defaults to hint exposure (onDemandDiscovery: false) without config', () => {
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

describe('readToolExposureConfig exposure policy (four-tier model)', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-tool-exposure3-'));
    delete process.env.DUYA_TOOLS_EXPOSURE;
    delete process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.DUYA_TOOLS_EXPOSURE;
    delete process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY;
  });

  it('defaults to hint exposure', () => {
    const config = readToolExposureConfig(tmpRoot);
    expect(config.exposure).toBe('hint');
    expect(config.onDemandDiscovery).toBe(false);
  });

  it('reads the explicit exposure keys', () => {
    for (const value of ['full', 'hint', 'search'] as const) {
      fs.writeFileSync(path.join(tmpRoot, 'config.toml'), `[tools]\nexposure = "${value}"\n`, 'utf-8');
      expect(readToolExposureConfig(tmpRoot).exposure).toBe(value);
    }
  });

  it('normalizes the retired catalog policy to hint', () => {
    fs.writeFileSync(path.join(tmpRoot, 'config.toml'), '[tools]\nexposure = "catalog"\n', 'utf-8');
    const config = readToolExposureConfig(tmpRoot);
    expect(config.exposure).toBe('hint');
    expect(config.onDemandDiscovery).toBe(false);
  });

  it('exposure key wins over the legacy boolean', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.toml'),
      '[tools]\nexposure = "hint"\non_demand_discovery = true\n',
      'utf-8',
    );
    expect(readToolExposureConfig(tmpRoot).exposure).toBe('hint');
  });

  it('maps legacy on_demand_discovery=true to search', () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config.toml'),
      '[tools]\non_demand_discovery = true\n',
      'utf-8',
    );
    const config = readToolExposureConfig(tmpRoot);
    expect(config.exposure).toBe('search');
    expect(config.onDemandDiscovery).toBe(true);
  });

  it('ignores invalid exposure values (keeps default)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'config.toml'), '[tools]\nexposure = "banana"\n', 'utf-8');
    expect(readToolExposureConfig(tmpRoot).exposure).toBe('hint');
  });

  it('env DUYA_TOOLS_EXPOSURE overrides config', () => {
    fs.writeFileSync(path.join(tmpRoot, 'config.toml'), '[tools]\nexposure = "full"\n', 'utf-8');
    process.env.DUYA_TOOLS_EXPOSURE = 'catalog';
    expect(readToolExposureConfig(tmpRoot).exposure).toBe('hint');
  });

  it('new env key wins over the legacy env key', () => {
    process.env.DUYA_TOOLS_ON_DEMAND_DISCOVERY = '1';
    process.env.DUYA_TOOLS_EXPOSURE = 'full';
    expect(readToolExposureConfig(tmpRoot).exposure).toBe('full');
  });
});

describe('mcpExposureToExposeMode', () => {
  it('maps each policy value to the registry ExposeMode', () => {
    const cases: Array<[MCPExposureMode, string]> = [
      ['full', 'always'],
      ['hint', 'hint'],
      ['search', 'discoverable'],
    ];
    for (const [policy, expected] of cases) {
      expect(mcpExposureToExposeMode(policy)).toBe(expected);
    }
  });
});

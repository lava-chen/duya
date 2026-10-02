import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  resolvePluginVersion,
  compareVersions,
  isVersionNewer,
  pickLatestVersion,
} from './version-resolver';

describe('resolvePluginVersion', () => {
  it('uses manifest version when available', () => {
    const version = resolvePluginVersion('.', {
      schemaVersion: 'duya.plugin.v1',
      id: 'test',
      name: 'Test',
      version: '1.2.3',
      description: 'test',
      author: { name: 'test' },
      capabilities: {},
      permissions: [],
      engines: { duya: '>=0.1.0' },
    });
    expect(version).toBe('1.2.3');
  });

  it('falls back to unknown when no manifest and no git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-test-'));
    try {
      const version = resolvePluginVersion(tmpDir);
      expect(version).toMatch(/^unknown-[a-z0-9]+$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns positive when a > b', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.3', '1.0.2')).toBeGreaterThan(0);
  });

  it('returns negative when a < b', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.2', '1.0.3')).toBeLessThan(0);
  });

  it('handles unknown versions', () => {
    expect(compareVersions('unknown', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', 'unknown')).toBeGreaterThan(0);
  });

  it('handles git SHA versions', () => {
    expect(compareVersions('abc1234', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', 'abc1234')).toBeGreaterThan(0);
  });
});

describe('isVersionNewer', () => {
  it('returns true when latest is newer', () => {
    expect(isVersionNewer('1.0.0', '2.0.0')).toBe(true);
    expect(isVersionNewer('1.0.0', '1.1.0')).toBe(true);
  });

  it('returns false when latest is same or older', () => {
    expect(isVersionNewer('2.0.0', '1.0.0')).toBe(false);
    expect(isVersionNewer('1.0.0', '1.0.0')).toBe(false);
  });
});

describe('pickLatestVersion', () => {
  it('returns null for empty array', () => {
    expect(pickLatestVersion([])).toBeNull();
  });

  it('returns the latest version', () => {
    expect(pickLatestVersion(['1.0.0', '2.0.0', '1.5.0'])).toBe('2.0.0');
  });

  it('returns single version', () => {
    expect(pickLatestVersion(['3.2.1'])).toBe('3.2.1');
  });
});
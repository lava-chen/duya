import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSafeJSON,
  readSafeStorage,
  removeSafeStorage,
  resetStorageBackendCache,
  writeSafeJSON,
  writeSafeStorage,
} from './safe-storage';

/**
 * node 环境下没有 `window`，正好覆盖"localStorage 完全不可用"的路径——
 * 这是隐私模式/受限 WebView 的真实形态。判据：所有导出都不抛错，
 * 读回退到默认值，同一次会话内写入仍然可见（内存降级层）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  resetStorageBackendCache();
});

describe('safe-storage without a real localStorage', () => {
  it('reads back what it wrote within the same session', () => {
    writeSafeStorage('duya-theme-preference', 'system');
    expect(readSafeStorage('duya-theme-preference')).toBe('system');
  });

  it('reports false when the write only reached the in-memory fallback', () => {
    expect(writeSafeStorage('k', 'v')).toBe(false);
  });

  it('returns null for a missing key instead of throwing', () => {
    expect(readSafeStorage('nope')).toBeNull();
  });

  it('removes values', () => {
    writeSafeStorage('k', 'v');
    removeSafeStorage('k');
    expect(readSafeStorage('k')).toBeNull();
  });
});

describe('safe-storage JSON helpers', () => {
  it('round-trips structured values', () => {
    writeSafeJSON('state', { a: 1, b: ['x'] });
    expect(readSafeJSON('state', null)).toEqual({ a: 1, b: ['x'] });
  });

  it('falls back when the stored payload is not valid JSON', () => {
    writeSafeStorage('broken', '{not json');
    expect(readSafeJSON('broken', { fallback: true })).toEqual({ fallback: true });
  });

  it('falls back when the guard rejects a stale shape', () => {
    writeSafeStorage('shaped', JSON.stringify({ version: 1, legacy: true }));
    const guard = (value: unknown): value is { version: number } =>
      typeof value === 'object' &&
      value !== null &&
      (value as { version?: unknown }).version === 2;

    expect(readSafeJSON('shaped', { version: 2 }, guard)).toEqual({ version: 2 });
  });

  it('returns false instead of throwing on unserializable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(writeSafeJSON('circular', circular)).toBe(false);
  });
});

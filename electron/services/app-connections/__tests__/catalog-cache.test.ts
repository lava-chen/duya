import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ scratch: '' }));

vi.mock('../../../logging/logger', () => ({
  safeUserDataPath: () => mocks.scratch,
}));

const {
  CONNECTORS_CACHE_TTL_MS,
  deleteCatalogCache,
  isFresh,
  readCatalogCache,
  writeCatalogCache,
} = await import('../catalog-cache');

describe('catalog-cache (Plan 450 Phase E)', () => {
  beforeAll(() => {
    mocks.scratch = mkdtempSync(path.join(tmpdir(), 'duya-catalog-cache-'));
  });

  beforeEach(() => {
    rmSync(mocks.scratch, { recursive: true, force: true });
    mkdirSync(mocks.scratch, { recursive: true });
  });

  afterEach(() => {
    rmSync(mocks.scratch, { recursive: true, force: true });
  });

  it('exposes the TTL constant', () => {
    expect(CONNECTORS_CACHE_TTL_MS).toBe(3_600_000);
  });

  it('returns null when no snapshot exists', () => {
    expect(readCatalogCache('conn-1')).toBeNull();
  });

  it('round-trips a written snapshot', () => {
    writeCatalogCache('conn-2', 'notion', [
      { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: {} } },
    ]);
    const cached = readCatalogCache('conn-2');
    expect(cached).not.toBeNull();
    expect(cached?.provider).toBe('notion');
    expect(cached?.tools).toHaveLength(1);
    expect(cached?.tools[0].name).toBe('create_page');
  });

  it('returns null for a malformed file', () => {
    mkdirSync(path.join(mocks.scratch, 'app-connections', 'catalog-cache'), { recursive: true });
    writeFileSync(path.join(mocks.scratch, 'app-connections', 'catalog-cache', 'conn-bad.json'), '{not json', 'utf8');
    expect(readCatalogCache('conn-bad')).toBeNull();
  });

  it('returns null when the file shape is wrong (missing tools)', () => {
    mkdirSync(path.join(mocks.scratch, 'app-connections', 'catalog-cache'), { recursive: true });
    writeFileSync(
      path.join(mocks.scratch, 'app-connections', 'catalog-cache', 'conn-wrong.json'),
      JSON.stringify({ fetchedAt: Date.now(), provider: 'x' }),
      'utf8',
    );
    expect(readCatalogCache('conn-wrong')).toBeNull();
  });

  it('flags a fresh snapshot as fresh', () => {
    writeCatalogCache('conn-3', 'figma', [{ name: 'export' }]);
    const cached = readCatalogCache('conn-3');
    expect(cached).not.toBeNull();
    expect(isFresh(cached!)).toBe(true);
  });

  it('flags a snapshot older than the TTL as stale', () => {
    const dir = path.join(mocks.scratch, 'app-connections', 'catalog-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'conn-stale.json'),
      JSON.stringify({
        fetchedAt: Date.now() - CONNECTORS_CACHE_TTL_MS - 1,
        provider: 'github',
        tools: [{ name: 'list_prs' }],
      }),
      'utf8',
    );
    const cached = readCatalogCache('conn-stale');
    expect(cached).not.toBeNull();
    expect(isFresh(cached!)).toBe(false);
  });

  it('deletes the snapshot', () => {
    writeCatalogCache('conn-4', 'linear', [{ name: 'create_issue' }]);
    expect(readCatalogCache('conn-4')).not.toBeNull();
    deleteCatalogCache('conn-4');
    expect(readCatalogCache('conn-4')).toBeNull();
    expect(existsSync(path.join(mocks.scratch, 'app-connections', 'catalog-cache', 'conn-4.json'))).toBe(false);
  });
});
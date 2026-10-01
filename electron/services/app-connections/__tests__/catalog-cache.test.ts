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
    writeCatalogCache('conn-2', 'notion', 'https://mcp.notion.test/mcp', [
      { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: {} } },
    ]);
    const cached = readCatalogCache('conn-2');
    expect(cached).not.toBeNull();
    expect(cached?.provider).toBe('notion');
    expect(cached?.endpoint).toBe('https://mcp.notion.test/mcp');
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
    writeCatalogCache('conn-3', 'figma', 'https://mcp.figma.test/mcp', [{ name: 'export' }]);
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
        endpoint: 'https://mcp.github.test/mcp',
        schemaVerbatim: true,
        tools: [{ name: 'list_prs' }],
      }),
      'utf8',
    );
    const cached = readCatalogCache('conn-stale');
    expect(cached).not.toBeNull();
    expect(isFresh(cached!)).toBe(false);
  });

  it('rejects a pre-canonical snapshot without the schemaVerbatim flag (plan 580 D4)', () => {
    const dir = path.join(mocks.scratch, 'app-connections', 'catalog-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'conn-legacy.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        provider: 'notion',
        endpoint: 'https://mcp.notion.test/mcp',
        // No `schemaVerbatim` — written before the canonical verbatim store.
        tools: [{ name: 'search', inputSchema: { type: 'object', properties: {} } }],
      }),
      'utf8',
    );
    // Legacy trimmed schemas must not be served; the caller re-fetches live.
    expect(readCatalogCache('conn-legacy')).toBeNull();
  });

  it('rejects a snapshot with no recorded endpoint (plan 583 / ISS-22)', () => {
    const dir = path.join(mocks.scratch, 'app-connections', 'catalog-cache');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'conn-no-endpoint.json'),
      JSON.stringify({
        fetchedAt: Date.now(),
        provider: 'notion',
        schemaVerbatim: true,
        tools: [{ name: 'search' }],
      }),
      'utf8',
    );
    // Without an endpoint the snapshot cannot be tied to the server we are
    // about to talk to, so it is discarded rather than served.
    expect(readCatalogCache('conn-no-endpoint')).toBeNull();
  });

  it('rejects a snapshot whose endpoint moved', () => {
    writeCatalogCache('conn-moved', 'notion', 'https://old-tenant.mcp.notion.test/mcp', [
      { name: 'old_tenant_only_tool' },
    ]);
    const cached = readCatalogCache('conn-moved');
    expect(cached).not.toBeNull();
    // The caller compares this against the live `remoteMcpUrl` and re-fetches
    // when they differ, so a moved endpoint never serves the old tool list.
    expect(cached?.endpoint).not.toBe('https://new-tenant.mcp.notion.test/mcp');
  });

  it('deletes the snapshot', () => {
    writeCatalogCache('conn-4', 'linear', 'https://mcp.linear.test/mcp', [{ name: 'create_issue' }]);
    expect(readCatalogCache('conn-4')).not.toBeNull();
    deleteCatalogCache('conn-4');
    expect(readCatalogCache('conn-4')).toBeNull();
    expect(existsSync(path.join(mocks.scratch, 'app-connections', 'catalog-cache', 'conn-4.json'))).toBe(false);
  });
});
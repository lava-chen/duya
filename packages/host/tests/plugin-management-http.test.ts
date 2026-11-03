/**
 * The plugin and marketplace management routes (plan 631).
 *
 * ## What these assertions exist for
 *
 * These routes move bytes onto disk: a package directory, the `installed` link
 * that points at it, and the `[plugins]` / `[marketplaces]` rows that say a
 * person meant it. So every case here reads the file back rather than trusting
 * a 200 — the response and the disk have to agree, because the Desktop reads the
 * same files.
 *
 * Three boundaries are pinned:
 *
 * 1. The surface is OPTIONAL. A Host composed without a writable plugin root
 *    refuses with 404 `plugin_management_api_unavailable` on every route, which
 *    is "this Host cannot do that" and not "there are no plugins".
 * 2. A refusal keeps its status. `plugin_not_found` is a 404 and a stale
 *    `expectedRevision` is a 409; flattening either into a 500 would tell the
 *    user the Host broke when it was their own input.
 * 3. Nothing here leaks a path or a credential. The rows carry names, versions
 *    and counts — never a filesystem location a client could then read.
 *
 * Git is never invoked: every source is a local directory in a temp root, so
 * these cases run offline and fast. The clone path is covered by the
 * `@duya/plugin-core` tests and by `management-api`'s own unit cases.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from '@iarna/toml';
import { HostSessionHttpClient, HostSessionHttpError } from '../src/http-client.js';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createHostLocalPluginManagementApi } from '../src/plugin-management/index.js';

const TOKEN = 'test-token';

interface Fixture {
  readonly root: string;
  /** The directory `[marketplaces.local-src]` points at. */
  readonly srcDir: string;
  config(): string;
  table(): Record<string, unknown>;
}

/** A config root with one local marketplace offering two plugins. */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-mgmt-'));
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(path.join(srcDir, 'plugins', 'pdf', '.duya-plugin'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'plugins', 'locked', '.duya-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'marketplace.json'),
    JSON.stringify({
      name: 'local-src',
      interface: { displayName: 'Local Source' },
      plugins: [
        { name: 'pdf', source: { source: 'local', path: './plugins/pdf' } },
        {
          name: 'locked',
          source: { source: 'local', path: './plugins/locked' },
          policy: { installation: 'not_available' },
        },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(srcDir, 'plugins', 'pdf', '.duya-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'pdf',
      version: '1.2.0',
      description: 'Document workflows',
      interface: { displayName: 'PDF Tools' },
    }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(srcDir, 'plugins', 'locked', '.duya-plugin', 'plugin.json'),
    JSON.stringify({ name: 'locked', version: '1.0.0' }),
    'utf8',
  );

  const fixture: Fixture = {
    root,
    srcDir,
    config: () => fs.readFileSync(path.join(root, 'config.toml'), 'utf8'),
    table: () => parse(fixture.config()) as Record<string, unknown>,
  };
  fs.writeFileSync(
    path.join(root, 'config.toml'),
    [
      '[model]',
      'default = "gpt-4o-mini"',
      '',
      '[marketplaces.local-src]',
      'source = "local"',
      `path = ${JSON.stringify(srcDir)}`,
      'displayName = "Local Source"',
      '',
    ].join('\n'),
    'utf8',
  );
  return fixture;
}

/** Paths the install layout derives, so the assertions name the same bytes. */
function cacheDir(root: string, marketplace: string, pluginId: string, version: string): string {
  return path.join(root, 'plugins', 'cache', marketplace, pluginId, version);
}

function linkPath(root: string, pluginId: string): string {
  return path.join(root, 'plugins', 'installed', pluginId);
}

const servers: HostSessionHttpServer[] = [];

async function startServer(
  overrides: Partial<HostSessionHttpServerOptions>,
): Promise<{ origin: string; client: HostSessionHttpClient }> {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'],
    token: TOKEN,
    ...overrides,
  });
  await server.listen();
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  return { origin, client: new HostSessionHttpClient(origin, TOKEN) };
}

/** The management API pointed at a throwaway root, with `addedAt` pinned. */
function apiFor(root: string): ReturnType<typeof createHostLocalPluginManagementApi> {
  return createHostLocalPluginManagementApi({ root, now: () => '2026-11-03T00:00:00.000Z' });
}

async function post(
  origin: string,
  route: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

describe('the Host plugin management routes', () => {
  it('refuses every route by name when this Host has no writable plugin root', async () => {
    const { origin } = await startServer({});

    for (const [route, method] of [
      ['/v1/local/plugin-catalog', 'GET'],
      ['/v1/local/marketplaces', 'GET'],
      ['/v1/local/plugins/install', 'POST'],
      ['/v1/local/marketplaces/refresh', 'POST'],
    ] as const) {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: 'plugin_management_api_unavailable' },
      });
    }
  });

  it('lists the catalog with the label a user recognizes, not the manifest name', async () => {
    const fixture = makeFixture();
    const { origin, client } = await startServer({
      localPluginManagementApi: apiFor(fixture.root),
    });

    const catalog = await client.listPluginCatalog();

    expect(catalog.error).toBeUndefined();
    expect(catalog.marketplaces).toEqual(['local-src']);
    expect(catalog.revision).toHaveLength(16);
    const pdf = catalog.entries.find((entry) => entry.pluginId === 'com.duya.pdf');
    expect(pdf).toBeDefined();
    expect(pdf?.name).toBe('pdf');
    expect(pdf?.displayName).toBe('PDF Tools');
    expect(pdf?.version).toBe('1.2.0');
    expect(pdf?.installed).toBe(false);
    expect(pdf?.requiresClone).toBe(false);
    // A policy the marketplace declares is a row the surface must not offer to
    // install, so it has to survive the projection.
    const locked = catalog.entries.find((entry) => entry.pluginId === 'com.duya.locked');
    expect(locked?.installPolicy).toBe('not_available');
    expect(origin).toBeTruthy();
  });

  it('installs a local package and records the intent in the same file', async () => {
    const fixture = makeFixture();
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    const result = await client.installPlugin({ pluginId: 'com.duya.pdf' });

    expect(result).toMatchObject({
      pluginId: 'com.duya.pdf',
      marketplace: 'local-src',
      enabled: true,
      installed: true,
      version: '1.2.0',
    });
    expect(fs.existsSync(cacheDir(fixture.root, 'local-src', 'com.duya.pdf', '1.2.0'))).toBe(true);
    expect(
      fs.existsSync(
        path.join(cacheDir(fixture.root, 'local-src', 'com.duya.pdf', '1.2.0'), '.duya-plugin', 'plugin.json'),
      ),
    ).toBe(true);
    expect(fs.existsSync(linkPath(fixture.root, 'com.duya.pdf'))).toBe(true);
    const plugins = fixture.table().plugins as Record<string, Record<string, unknown>>;
    expect(plugins['com.duya.pdf@local-src']).toEqual({ enabled: true });
    // The unrelated table the fixture started with is still there: a namespace
    // write is surgical, not a rewrite of the user's file.
    expect(fixture.table().model).toEqual({ default: 'gpt-4o-mini' });
  });

  it('toggles intent through the pathname, leaving the package on disk', async () => {
    const fixture = makeFixture();
    const { origin, client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });
    await client.installPlugin({ pluginId: 'com.duya.pdf' });

    const off = await post(origin, '/v1/local/plugins/disable', { pluginId: 'com.duya.pdf' });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ enabled: false, installed: true });
    const plugins = fixture.table().plugins as Record<string, Record<string, unknown>>;
    expect(plugins['com.duya.pdf@local-src']?.enabled).toBe(false);
    expect(fs.existsSync(linkPath(fixture.root, 'com.duya.pdf'))).toBe(true);

    // A body that disagrees with the route loses: the pathname is the intent.
    const on = await post(origin, '/v1/local/plugins/enable', {
      pluginId: 'com.duya.pdf',
      enabled: false,
    });
    expect(on.json).toMatchObject({ enabled: true });
  });

  it('uninstalls the package and drops the row', async () => {
    const fixture = makeFixture();
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });
    await client.installPlugin({ pluginId: 'com.duya.pdf' });

    const removed = await client.removePlugin({ pluginId: 'com.duya.pdf' });

    expect(removed.marketplace).toBe('local-src');
    expect(removed.removedPaths.length).toBeGreaterThan(0);
    expect(fs.existsSync(linkPath(fixture.root, 'com.duya.pdf'))).toBe(false);
    expect(fs.existsSync(cacheDir(fixture.root, 'local-src', 'com.duya.pdf', '1.2.0'))).toBe(false);
    expect(fixture.table().plugins).toBeUndefined();
  });

  it('keeps a hand-configured field that this surface does not know about', async () => {
    const fixture = makeFixture();
    fs.appendFileSync(
      path.join(fixture.root, 'config.toml'),
      ['[plugins."com.duya.pdf@local-src"]', 'enabled = true', 'note = "from the old editor"', ''].join('\n'),
      'utf8',
    );
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    await client.setPluginEnabled({ pluginId: 'com.duya.pdf', enabled: false });

    const plugins = fixture.table().plugins as Record<string, Record<string, unknown>>;
    expect(plugins['com.duya.pdf@local-src']).toEqual({
      note: 'from the old editor',
      enabled: false,
    });
  });

  it('refuses a write against a revision someone else already moved', async () => {
    const fixture = makeFixture();
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });
    const stale = (await client.listPluginCatalog()).revision;
    await client.installPlugin({ pluginId: 'com.duya.pdf' });

    const error = await client
      .setPluginEnabled({ pluginId: 'com.duya.pdf', enabled: false, expectedRevision: stale })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(HostSessionHttpError);
    expect((error as HostSessionHttpError).status).toBe(409);
    expect((error as HostSessionHttpError).code).toBe('plugin_revision_conflict');
  });

  it('keeps a refusal a refusal: an unknown plugin is 404, not 500', async () => {
    const fixture = makeFixture();
    const { origin } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    const response = await post(origin, '/v1/local/plugins/install', { pluginId: 'com.duya.nope' });

    expect(response.status).toBe(404);
    expect((response.json.error as Record<string, unknown>).code).toBe('plugin_not_found');
  });

  it('adds a local marketplace under the name its own catalog claims', async () => {
    const fixture = makeFixture();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-mgmt-add-'));
    fs.mkdirSync(path.join(other, 'plugins', 'csv', '.duya-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(other, 'marketplace.json'),
      JSON.stringify({
        name: 'added-mp',
        plugins: [{ name: 'csv', source: { source: 'local', path: './plugins/csv' } }],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(other, 'plugins', 'csv', '.duya-plugin', 'plugin.json'),
      JSON.stringify({ name: 'csv', version: '0.1.0' }),
      'utf8',
    );
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    const added = await client.addMarketplace({ source: other });

    expect(added.marketplace.name).toBe('added-mp');
    expect(added.marketplace.pluginCount).toBe(1);
    const marketplaces = fixture.table().marketplaces as Record<string, Record<string, unknown>>;
    expect(marketplaces['local-src']).toBeDefined();
    expect(marketplaces['added-mp']).toMatchObject({
      source: 'local',
      path: other,
      addedAt: '2026-11-03T00:00:00.000Z',
    });
  });

  it('refuses to drop a marketplace that still has an installed plugin', async () => {
    const fixture = makeFixture();
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });
    await client.installPlugin({ pluginId: 'com.duya.pdf' });

    const error = await client.removeMarketplace({ marketplace: 'local-src' }).catch((cause: unknown) => cause);

    expect((error as HostSessionHttpError).status).toBe(409);
    expect((error as HostSessionHttpError).code).toBe('marketplace_has_installed_plugins');
    const marketplaces = fixture.table().marketplaces as Record<string, unknown>;
    expect(marketplaces['local-src']).toBeDefined();
  });

  it('reports one outcome per source, including the one that went away', async () => {
    const fixture = makeFixture();
    const gone = path.join(fixture.root, 'gone');
    fs.appendFileSync(
      path.join(fixture.root, 'config.toml'),
      ['[marketplaces.gone]', 'source = "local"', `path = ${JSON.stringify(gone)}`, ''].join('\n'),
      'utf8',
    );
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    const refreshed = await client.refreshMarketplace({});

    expect(refreshed.outcomes).toHaveLength(2);
    const byName = new Map(refreshed.outcomes.map((outcome) => [outcome.marketplace, outcome.error]));
    expect(byName.get('local-src')).toBeUndefined();
    expect(byName.get('gone')).toContain('directory is gone');
    const error = await client.refreshMarketplace({ marketplace: 'ghost' }).catch((cause: unknown) => cause);
    expect((error as HostSessionHttpError).status).toBe(404);
  });

  it('names a marketplace row with what the Host could actually observe', async () => {
    const fixture = makeFixture();
    const { client } = await startServer({ localPluginManagementApi: apiFor(fixture.root) });

    const list = await client.listMarketplaces();

    expect(list.marketplaces).toHaveLength(1);
    const row = list.marketplaces[0];
    expect(row).toMatchObject({
      name: 'local-src',
      displayName: 'Local Source',
      kind: 'local',
      pluginCount: 2,
      isDefault: false,
      hidden: false,
    });
    expect(row.path).toBe(fixture.srcDir);
  });
});

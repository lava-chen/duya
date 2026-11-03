import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import { HostSessionHttpServer, type HostSessionHttpServerOptions } from '../src/http-server.js';
import { createPluginServices } from '../src/plugins/service.js';
import { createPluginManagementApi } from '../src/plugins/management-api.js';
import { createPluginAudit } from '../src/plugins/audit.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-plugin-management-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const configRoot = path.join(root, 'profile');
  const source = path.join(root, 'source');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(configRoot);
  fs.writeFileSync(path.join(configRoot, 'config.toml'), '# Keep this comment\n[model]\neffort = "high"\n');
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({
    schemaVersion: 'duya.plugin.v2', id: 'com.duya.fixture', name: 'Fixture', version: '1.0.0',
    description: 'Fixture plugin', author: { name: 'Fixture' }, permissions: [], engines: { duya: '>=0.1.0' },
    capabilities: { mcpServers: [{ name: 'fixture', command: 'node', env: { KEY: 'secret-marker' } }] },
  }));
  const values: Record<string, Record<string, string>> = {};
  const setup = { async listPluginSetupValues() { return values; }, async mergePluginSetupValues(id: string, next: Record<string, string>) { values[id] = { ...values[id], ...next }; }, async clearPluginSetupValues(id: string) { delete values[id]; } };
  const options = { configRoot, logger: { debug() { }, info() { }, warn() { }, error() { } }, setupApi: () => setup };
  return { configRoot, source, options, values, services: createPluginServices(options) };
}

async function http(f: ReturnType<typeof fixture>) {
  const server = new HostSessionHttpServer({
    api: {} as HostSessionHttpServerOptions['api'],
    taskApi: {} as HostSessionHttpServerOptions['taskApi'], token: 'test-token',
    pluginManagementApi: createPluginManagementApi(f.services.manager, f.services),
    pluginManagementAudit: createPluginAudit(f.configRoot, () => {})
  });
  await server.listen();
  cleanup.push(() => server.close());
  return async (route: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1/plugins${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('shared plugin management without Electron', () => {
  it('reads and removes legacy Desktop package storage while preserving one shared config source', async () => {
    const f = fixture();
    const legacy = path.join(path.dirname(f.source), 'legacy-desktop');
    const packagePath = path.join(legacy, 'plugins', 'cache', 'local', 'com.duya.fixture', '1.0.0');
    const installed = path.join(legacy, 'plugins', 'installed');
    fs.mkdirSync(installed, { recursive: true });
    fs.cpSync(f.source, packagePath, { recursive: true });
    fs.symlinkSync(packagePath, path.join(installed, 'com.duya.fixture'), process.platform === 'win32' ? 'junction' : 'dir');
    const dataPath = path.join(legacy, 'plugins-data', 'com.duya.fixture');
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(f.configRoot, 'config.toml'), '[plugins."com.duya.fixture@local"]\nenabled = true\n');
    const services = createPluginServices({ ...f.options, legacyRoots: [legacy] });
    expect(services.manager.listInstalled()[0]).toMatchObject({ installPath: fs.realpathSync(packagePath), dataPath });
    const api = createPluginManagementApi(services.manager, services);
    await api.uninstall('com.duya.fixture', true);
    expect(fs.existsSync(packagePath)).toBe(false);
    expect(fs.existsSync(dataPath)).toBe(false);
    expect((await api.list()).plugins).toEqual([]);
  });

  it('uses the same marketplace service for catalog installs and protects installed sources from removal', async () => {
    const f = fixture();
    const marketRoot = path.join(path.dirname(f.source), 'market');
    fs.mkdirSync(path.join(marketRoot, 'plugins'), { recursive: true });
    fs.cpSync(f.source, path.join(marketRoot, 'plugins', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(marketRoot, 'marketplace.json'), JSON.stringify({
      name: 'fixture-market', plugins: [
        { name: 'fixture', source: { source: 'local', path: './plugins/fixture' }, policy: { installation: 'available' } },
      ]
    }));
    const api = createPluginManagementApi(f.services.manager, f.services);
    await api.addMarketplace(marketRoot);
    expect((await api.listMarketplaces()).marketplaces[0]).toMatchObject({ name: 'fixture-market', pluginCount: 1 });
    const catalog = await api.catalog();
    expect(catalog.plugins).toEqual([expect.objectContaining({ id: 'com.duya.fixture', marketplace: 'fixture-market', installed: false })]);
    await api.install({ pluginId: 'com.duya.fixture', marketplace: 'fixture-market' });
    await expect(api.removeMarketplace('fixture-market')).rejects.toThrow();
    await api.uninstall('com.duya.fixture', false);
    await api.removeMarketplace('fixture-market');
    expect((await api.listMarketplaces()).marketplaces).toEqual([]);
  });

  it('refuses to delete an installed link that points outside managed package storage', async () => {
    const f = fixture();
    const api = createPluginManagementApi(f.services.manager, f.services);
    await api.install({ fromPath: f.source });
    const installedLink = path.join(f.configRoot, 'plugins', 'installed', 'com.duya.fixture');
    fs.unlinkSync(installedLink);
    fs.symlinkSync(f.source, installedLink, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(api.uninstall('com.duya.fixture', false)).rejects.toThrow();
    expect(fs.existsSync(f.source)).toBe(true);
    expect((await api.list()).plugins).toHaveLength(1);
  });

  it('installs through HTTP, sees current config from another instance, toggles and removes the same package', async () => {
    const f = fixture();
    const request = await http(f);
    const installed = await request('/install', { fromPath: f.source });
    expect(installed.status).toBe(200);
    const installBody = await installed.json();
    expect(installBody.plugin).toMatchObject({ id: 'com.duya.fixture', enabled: true, installed: true, version: '1.0.0' });
    expect(JSON.stringify(installBody)).not.toContain('secret-marker');
    expect(JSON.stringify(installBody)).not.toContain('installPath');
    const audit = fs.readFileSync(path.join(f.configRoot, 'control-plane-audit.log.jsonl'), 'utf8');
    expect(audit).toContain('"kind":"plugin.install"');
    expect(audit).toContain('"invokedBy":"cli"');
    expect(audit).not.toContain(f.source);
    expect(audit).not.toContain('secret-marker');
    const second = createPluginManagementApi(createPluginServices(f.options).manager);
    expect((await second.list()).plugins).toHaveLength(1);
    expect((await request('/com.duya.fixture/disable', {})).status).toBe(200);
    expect((await second.info('com.duya.fixture')).enabled).toBe(false);
    const raw = fs.readFileSync(path.join(f.configRoot, 'config.toml'), 'utf8');
    expect(raw).toContain('# Keep this comment');
    expect((parse(raw).model as { effort: string }).effort).toBe('high');
    await second.uninstall('com.duya.fixture', false);
    expect((await (await request('')).json()).plugins).toEqual([]);
    expect(fs.existsSync(path.join(f.configRoot, 'plugins', 'installed', 'com.duya.fixture'))).toBe(false);
    expect(fs.existsSync(f.source)).toBe(true);
  });

  it('preserves corrupt config and refuses a package with a traversing id before installing', async () => {
    const f = fixture();
    const manifestPath = path.join(f.source, 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: '../escape' }));
    const api = createPluginManagementApi(f.services.manager);
    await expect(api.install({ fromPath: f.source })).rejects.toThrow();
    expect(fs.existsSync(path.join(f.configRoot, 'plugins', 'escape'))).toBe(false);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.configRoot, 'config.toml'), 'broken = [');
    await expect(api.install({ fromPath: f.source })).rejects.toThrow();
    expect(fs.readFileSync(path.join(f.configRoot, 'config.toml'), 'utf8')).toBe('broken = [');
  });

  it('applies the same managed-plugin policy to standalone mutations', async () => {
    const f = fixture();
    const api = createPluginManagementApi(f.services.manager);
    await api.install({ fromPath: f.source });
    f.services.manager.getPolicyEngine().updatePolicy({ managedPlugins: { 'com.duya.fixture': { enabled: true, version: '1.0.0', config: {} } } });
    await expect(api.setEnabled('com.duya.fixture', false)).rejects.toThrow();
    await expect(api.uninstall('com.duya.fixture', true)).rejects.toThrow();
    expect((await api.info('com.duya.fixture')).enabled).toBe(true);
  });
});

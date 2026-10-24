import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDuya, invokeApi, launchDuya, showWorkTab, userDataRootFor, type DuyaApp } from '../helpers';

let app: DuyaApp;
let namespace = '';
let pluginParent = '';
let pluginPath: string;

test.afterEach(async () => {
  if (app) {
    await closeDuya(app.app);
    app = undefined as unknown as DuyaApp;
  }
  if (namespace) {
    fs.rmSync(userDataRootFor(namespace), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    namespace = '';
  }
  if (pluginParent) {
    fs.rmSync(pluginParent, { recursive: true, force: true });
    pluginParent = '';
    pluginPath = '';
  }
});

test('installed MCP surface appears in Apps and loads its resource in the panel', async () => {
  pluginParent = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-report-viewer-e2e-'));
  pluginPath = path.join(pluginParent, 'package');
  fs.cpSync(path.resolve(process.cwd(), 'plugins/examples/report-viewer'), pluginPath, { recursive: true });

  // Keep the shipped example session-scoped. The product-path fixture uses
  // `always` so the real Apps launcher can open without configuring a model.
  const manifestPath = path.join(pluginPath, '.duya-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    extensions: { 'com.duya.client': { apps: Array<{ ui: { surfaces: Array<{ availability: string }> } }> } };
  };
  manifest.extensions['com.duya.client'].apps[0].ui.surfaces[0].availability = 'always';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  namespace = `plugin-ui-resource-surface-${process.pid}-${Date.now()}`;
  app = await launchDuya({ namespace });
  const installed = await invokeApi<{ success: boolean; error?: string }>(
    app.page,
    'plugin.installLocal',
    { pluginPath, scope: 'user' },
  );
  expect(installed.success, installed.error).toBe(true);

  const directory = await invokeApi<{
    success: boolean;
    data: { surfaces: Array<{ id: string; pluginId: string; resourceUri: string }> };
  }>(app.page, 'plugin.uiSurfaces.list');
  expect(directory.success).toBe(true);
  expect(directory.data.surfaces).toContainEqual(expect.objectContaining({
    id: 'report-overview',
    pluginId: 'com.duya.examples.report-viewer',
    resourceUri: 'ui://reports/overview',
  }));

  const skipOnboarding = app.page.getByRole('button', { name: 'Skip', exact: true });
  await expect(skipOnboarding).toBeVisible({ timeout: 20_000 });
  await skipOnboarding.click();
  await showWorkTab(app.page);
  await app.page.getByRole('button', { name: 'Apps', exact: true }).click();
  await expect(app.page.getByRole('heading', { name: 'Mini Apps', exact: true })).toBeVisible();
  await expect(app.page.getByRole('heading', { name: 'Report Viewer', exact: true })).toBeVisible();
  const launchSurface = app.page.getByRole('button', { name: 'Report overview', exact: true });
  await expect(launchSurface).toBeVisible();
  await launchSurface.click();

  const iframe = app.page.locator('iframe[title="Report overview"]');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  const frame = app.page.frameLocator('iframe[title="Report overview"]');
  await expect(frame.getByRole('heading', { name: 'Report overview', exact: true })).toBeVisible();
  await expect(frame.getByText('This read-only page is loaded from the plugin\'s MCP resource.')).toBeVisible();
  await expect(frame.locator('tbody tr')).toHaveCount(3);

  const entryUrl = new URL((await iframe.getAttribute('src'))!);
  expect(entryUrl.hostname).toBe('127.0.0.1');
  expect(entryUrl.pathname).toMatch(/^\/[^/]+\/index\.html$/);

  await launchSurface.click();
  await expect(iframe).toHaveCount(1);
});
